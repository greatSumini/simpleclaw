import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { log } from '../log.js';
import {
  deleteBackgroundJob,
  getOldFinishedJobs,
  getPendingRunJobs,
  getUnreapedFinishedRunJobs,
  markBackgroundJobReaped,
  parseDbUtc,
} from '../state/background-jobs.js';
import { pruneRunTokens } from '../state/run-tokens.js';
import {
  SHARED_DAEMON_PATTERN,
  dirSizeBytes,
  isSameProcessAlive,
  jobGroupMembers,
  jobsRoot,
  killGroup,
  residueReport,
  safeJobDir,
} from './job-process.js';
import type { Queue } from './background-jobs.js';

/**
 * Ownership-based garbage collector for claw-job.
 *
 * Detaching jobs from the engine session removed the accidental cleanup that session exit used
 * to do, so something has to reap what jobs leave behind. It only ever touches what SimpleClaw
 * itself recorded at creation — never "whatever looks orphaned" (the host has legitimate
 * long-lived ppid=1 daemons: vmc-bot, hermes, colima…):
 *
 *   - process groups of finished / expired `run` jobs  (identity-checked: pgid + start time)
 *   - job directories under ~/.simpleclaw/jobs older than 7 days
 *   - finished job rows older than 30 days, stale run tokens, mail.poll events older than 14 days
 *
 * Until SIMPLECLAW_GC_ENFORCE=1 it runs dry: every would-be action is logged and summarised to
 * the owner channel instead of performed. Anything it doesn't own (unregistered orphans) is only
 * ever reported, weekly and only when that list changed.
 */

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const JOB_DIR_RETENTION_MS = 7 * DAY;
const JOB_ROW_RETENTION_MS = 30 * DAY;
const MAIL_POLL_RETENTION_MS = 14 * DAY;
const DRY_RUN_SUMMARY_WINDOW_MS = 14 * DAY;
const LONG_RUNNING_MS = 6 * HOUR;
const ORPHAN_MIN_AGE_MS = DAY;
/** Tools agent sessions typically leave running — only these are listed as possible orphans. */
const ORPHAN_TOOL_PATTERN = /ffmpeg|whisper|yt-dlp|browser[_-]?harness/i;

interface GcState {
  dryRunSince?: number;
  lastDailyAt?: number;
  lastWeeklyAt?: number;
  weeklySignature?: string;
  /** Job ids whose "still running after expiry (dry-run)" note was already posted. */
  dryRunNotified?: number[];
  /** Pending dry-run summary lines, flushed daily. */
  dryRunCandidates?: string[];
}

export interface JobGcOptions {
  /** Where GC keeps its small JSON state (survives the frequent restarts). */
  stateFile: string;
  /** Actually kill/delete. False = dry-run (log + summarise only). */
  enforce: boolean;
}

export class JobGarbageCollector {
  private readonly db: Database.Database;
  private readonly opts: JobGcOptions;
  private lastHourlyAt = 0;

  constructor(db: Database.Database, opts: JobGcOptions) {
    this.db = db;
    this.opts = opts;
  }

  private loadState(): GcState {
    try {
      return JSON.parse(fs.readFileSync(this.opts.stateFile, 'utf8')) as GcState;
    } catch {
      return {};
    }
  }

  private saveState(state: GcState): void {
    try {
      fs.writeFileSync(this.opts.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'job-gc: state save failed');
    }
  }

  /** Called after every scheduler poll. */
  async afterPoll(queue: Queue, ownerQueue: (msg: string) => void): Promise<void> {
    const state = this.loadState();
    if (!this.opts.enforce && state.dryRunSince === undefined) state.dryRunSince = Date.now();

    await this.reapProcessGroups(state, queue, ownerQueue);

    if (Date.now() - this.lastHourlyAt >= HOUR) {
      this.lastHourlyAt = Date.now();
      this.hourly(state);
    }
    this.dailyDryRunSummary(state, ownerQueue);
    this.weeklyReport(state, ownerQueue);
    this.saveState(state);
  }

  // ── processes ────────────────────────────────────────────────────────────────

  private async reapProcessGroups(state: GcState, queue: Queue, ownerQueue: (msg: string) => void): Promise<void> {
    for (const job of getUnreapedFinishedRunJobs(this.db)) {
      const members = jobGroupMembers(job.pid!, job.procStartedAt);
      if (members.length === 0) {
        markBackgroundJobReaped(this.db, job.id);
        continue;
      }
      const list = members.map((m) => `  ${m.pid} ${m.command.slice(0, 120)}`).join('\n');

      // A browser another session may be driving is never killed with the group.
      if (members.some((m) => SHARED_DAEMON_PATTERN.test(m.command))) {
        markBackgroundJobReaped(this.db, job.id);
        queue(
          job.threadId,
          `⚠️ job #${job.id}(${job.status}) 뒤에 브라우저 계열 프로세스가 남아 있어 자동 정리를 보류했습니다 — 다른 세션이 쓰는 중일 수 있습니다. 목록은 simpleclaw 채널에 남겼습니다.`,
        );
        ownerQueue(`🧹 GC 보류 — job #${job.id} "${job.description}" 프로세스 그룹에 공유 가능 프로세스 포함:\n${list}`);
        continue;
      }

      if (!this.opts.enforce) {
        log.info({ jobId: job.id, members: members.length }, 'job-gc (dry-run): would kill process group');
        this.addCandidate(state, `job #${job.id} "${job.description}"(${job.status}) 프로세스 그룹 ${members.length}개 종료 예정`);
        const notified = new Set(state.dryRunNotified ?? []);
        if (!notified.has(job.id)) {
          notified.add(job.id);
          state.dryRunNotified = [...notified].slice(-200);
          queue(
            job.threadId,
            `⚠️ job #${job.id}은 ${job.status === 'expired' ? '만료됐지만' : '끝났지만'} 프로세스 ${members.length}개가 아직 실행 중입니다. ` +
              '자동 정리가 점검 기간(dry-run)이라 종료하지 않았습니다 — 필요 없으면 "취소해줘"라고 해주세요.',
          );
        }
        continue;
      }

      await killGroup(job.pid!, 30_000);
      markBackgroundJobReaped(this.db, job.id);
      const residue = residueReport(job.cwd);
      queue(
        job.threadId,
        `🧹 job #${job.id}(${job.status})의 남은 프로세스 ${members.length}개를 종료했습니다.` +
          (residue.length ? `\n정리가 필요할 수 있는 잔해:\n${residue.map((r) => `- ${r}`).join('\n')}` : ''),
      );
      ownerQueue(`🧹 GC kill — job #${job.id} "${job.description}" (thread <#${job.threadId}>):\n${list}`);
    }
  }

  // ── files & rows (hourly) ────────────────────────────────────────────────────

  private hourly(state: GcState): void {
    try {
      const pruned = pruneRunTokens(this.db);
      if (pruned > 0) log.info({ pruned }, 'job-gc: pruned run tokens');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'job-gc: token prune failed');
    }

    const now = Date.now();
    for (const job of getOldFinishedJobs(this.db, new Date(now - JOB_DIR_RETENTION_MS))) {
      const finishedAt = parseDbUtc(job.checkedAt ?? job.createdAt);
      const dir = job.jobDir ? safeJobDir(job.jobDir) : null;
      if (dir && fs.existsSync(dir)) {
        if (this.opts.enforce) fs.rmSync(dir, { recursive: true, force: true });
        else this.addCandidate(state, `job #${job.id} 디렉토리 삭제 예정 (${Math.round(dirSizeBytes(dir) / 1024)}KB)`);
      }
      if (finishedAt < now - JOB_ROW_RETENTION_MS && (!job.pid || job.reaped)) {
        if (this.opts.enforce) deleteBackgroundJob(this.db, job.id);
        else this.addCandidate(state, `job #${job.id} 기록 삭제 예정 (30일 경과)`);
      }
    }

    const cutoff = new Date(now - MAIL_POLL_RETENTION_MS).toISOString();
    if (this.opts.enforce) {
      // Batched: one huge DELETE fans out through the FTS trigger and holds the write lock.
      let total = 0;
      for (;;) {
        const n = this.db
          .prepare(
            "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE type = 'mail.poll' AND ts < ? LIMIT 1000)",
          )
          .run(cutoff).changes;
        total += n;
        if (n < 1000) break;
      }
      if (total > 0) log.info({ deleted: total }, 'job-gc: pruned mail.poll events');
    } else {
      const { n } = this.db
        .prepare<[string], { n: number }>("SELECT count(*) AS n FROM events WHERE type = 'mail.poll' AND ts < ?")
        .get(cutoff)!;
      if (n > 0) this.addCandidate(state, `14일 지난 mail.poll 이벤트 ${n}행 삭제 예정`, 'mail.poll');
    }
  }

  private addCandidate(state: GcState, line: string, dedupeKey?: string): void {
    const list = (state.dryRunCandidates ?? []).filter((l) => (dedupeKey ? !l.includes(dedupeKey) : l !== line));
    list.push(line);
    state.dryRunCandidates = list.slice(-50);
  }

  /** Once a day during the first two weeks of dry-run, and only when there is something to say. */
  private dailyDryRunSummary(state: GcState, ownerQueue: (msg: string) => void): void {
    if (this.opts.enforce) return;
    const now = Date.now();
    if (state.lastDailyAt !== undefined && now - state.lastDailyAt < DAY) return;
    const since = state.dryRunSince ?? now;
    const candidates = state.dryRunCandidates ?? [];
    if (candidates.length === 0) return;
    state.lastDailyAt = now;
    state.dryRunCandidates = [];
    if (now - since > DRY_RUN_SUMMARY_WINDOW_MS) return; // window over — keep logging only
    ownerQueue(
      `🧹 GC dry-run 일일 요약 (실제로는 아무것도 지우거나 종료하지 않았음):\n` +
        candidates.map((c) => `- ${c}`).join('\n') +
        '\n문제 없어 보이면 SIMPLECLAW_GC_ENFORCE=1로 실제 정리를 켤 수 있습니다.',
    );
  }

  // ── weekly report (report-only) ──────────────────────────────────────────────

  private weeklyReport(state: GcState, ownerQueue: (msg: string) => void): void {
    const now = Date.now();
    if (state.lastWeeklyAt !== undefined && now - state.lastWeeklyAt < 7 * DAY) return;
    state.lastWeeklyAt = now;

    const lines: string[] = [];
    const sigParts: string[] = [];

    const longRunning = getPendingRunJobs(this.db).filter(
      (j) => j.pid !== null && isSameProcessAlive(j.pid, j.procStartedAt) && now - parseDbUtc(j.createdAt) > LONG_RUNNING_MS,
    );
    if (longRunning.length) {
      lines.push(`6시간 넘게 실행 중인 job: ${longRunning.map((j) => `#${j.id} ${j.description}`).join(', ')}`);
      sigParts.push(`long:${longRunning.map((j) => j.id).join(',')}`);
    }

    const root = jobsRoot();
    if (fs.existsSync(root)) {
      const mb = Math.round(dirSizeBytes(root) / (1024 * 1024));
      if (mb >= 100) {
        lines.push(`job 디렉토리 용량: ${mb}MB (${root})`);
        sigParts.push(`size:${Math.round(mb / 100)}`);
      }
    }

    const orphans = findUnregisteredOrphans(this.db);
    if (orphans.length) {
      lines.push(
        `등록되지 않은 장기 고아 프로세스 (자동 정리 대상 아님 — 확인 필요):\n` +
          orphans.map((o) => `  ${o.pid} (${Math.round(o.ageMs / DAY)}일째) ${o.command.slice(0, 110)}`).join('\n'),
      );
      sigParts.push(`orphans:${orphans.map((o) => o.pid).join(',')}`);
    }

    const signature = sigParts.join('|');
    if (signature === (state.weeklySignature ?? '')) return; // nothing changed since last week
    state.weeklySignature = signature;
    if (lines.length === 0) return;
    ownerQueue(`📋 주간 백그라운드 작업 점검\n${lines.join('\n')}`);
  }
}

/** `ps` etime ([[dd-]hh:]mm:ss) → ms. */
export function parseEtime(etime: string): number {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d = '0', h = '0', min = '0', s = '0'] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1_000;
}

export interface OrphanProcess {
  pid: number;
  ageMs: number;
  command: string;
}

/** Long-lived ppid=1 agent-tool processes that no registered job accounts for. Report-only. */
export function findUnregisteredOrphans(db: Database.Database): OrphanProcess[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,command='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const registered = new Set(
    (db.prepare('SELECT pid FROM background_jobs WHERE pid IS NOT NULL').all() as Array<{ pid: number }>).map(
      (r) => r.pid,
    ),
  );
  const result: OrphanProcess[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, pgid, etime, command] = m;
    if (ppid !== '1' || !ORPHAN_TOOL_PATTERN.test(command!)) continue;
    if (registered.has(Number(pgid))) continue;
    const ageMs = parseEtime(etime!);
    if (ageMs < ORPHAN_MIN_AGE_MS) continue;
    result.push({ pid: Number(pid), ageMs, command: command! });
  }
  return result.slice(0, 15);
}

export function defaultGcStateFile(dataDir: string): string {
  return path.join(dataDir, 'gc-state.json');
}

