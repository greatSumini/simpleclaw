import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { log } from '../log.js';
import {
  type BackgroundJobRow,
  getPendingBackgroundJobs,
  markBackgroundJobExpiryWarned,
  markBackgroundJobReaped,
  markBackgroundJobStatus,
  parseDbUtc,
  recordBackgroundJobCheck,
} from '../state/background-jobs.js';
import { tokenBelongsToThread } from '../state/run-tokens.js';
import { readExitCode, tailLog } from './job-process.js';

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 60 * 1_000;
const CHECK_TIMEOUT_MS = 30 * 1_000;
const CHECK_CONCURRENCY = 3;
/** Consecutive "the check itself is broken" results before we tell the thread. */
const BROKEN_STREAK_THRESHOLD = 3;
/** Heads-up before a detached job's TTL runs out, so it can be extended instead of cut off. */
const EXPIRY_WARNING_MS = 30 * 60 * 1_000;

export type Queue = (threadId: string, msg: string) => void;

export interface AfterPollHook {
  afterPoll(queue: Queue, ownerQueue: (msg: string) => void): Promise<void>;
}

/** Discord rejects messages over 2000 chars — and a rejected notice is a silent one. */
const DISCORD_SAFE_LEN = 1_900;

/** Pack messages into as few posts as possible, each under Discord's limit. */
export function packMessages(msgs: string[]): string[] {
  const posts: string[] = [];
  let cur = '';
  for (const raw of msgs) {
    const m = raw.length > DISCORD_SAFE_LEN ? `${raw.slice(0, DISCORD_SAFE_LEN - 1)}…` : raw;
    if (cur && cur.length + 2 + m.length > DISCORD_SAFE_LEN) {
      posts.push(cur);
      cur = m;
    } else {
      cur = cur ? `${cur}\n\n${m}` : m;
    }
  }
  if (cur) posts.push(cur);
  return posts;
}

/** Last lines of a job log, each clipped, fenced for Discord. */
function fencedTail(jobDir: string, lines: number): string {
  const tail = tailLog(jobDir, lines)
    .split('\n')
    .map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l))
    .join('\n')
    .replace(/```/g, "'''");
  return tail ? `\n\`\`\`\n${tail}\n\`\`\`` : '';
}

export type CheckOutcome =
  | { kind: 'done' }
  /** check_cmd ran and said "not yet" (plain non-zero exit). */
  | { kind: 'not-yet'; detail: string }
  /** check_cmd could not meaningfully run: missing command, missing cwd, or timed out. */
  | { kind: 'broken'; detail: string };

/**
 * Tell "not finished yet" apart from "this check can never succeed".
 *
 * Previously every failure was swallowed as "not yet", so a typo'd check_cmd (exit 127) or a
 * deleted cwd sat silently until the TTL ran out — the user only learned about it by asking.
 */
export function classifyCheckFailure(err: unknown): CheckOutcome {
  const e = err as { code?: unknown; killed?: boolean; signal?: string | null; stderr?: string; message?: string };
  const stderr = (e.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
  if (e.killed || e.signal) {
    return { kind: 'broken', detail: `조건 명령이 ${CHECK_TIMEOUT_MS / 1000}초 안에 끝나지 않음` };
  }
  if (typeof e.code === 'string') {
    // spawn-level failure — for exec this is almost always a cwd that no longer exists.
    return { kind: 'broken', detail: `실행 불가 (${e.code}): ${e.message ?? ''}`.trim() };
  }
  if (e.code === 126 || e.code === 127) {
    return { kind: 'broken', detail: `exit ${e.code}${stderr ? ` — ${stderr}` : ''}` };
  }
  return { kind: 'not-yet', detail: `exit ${String(e.code ?? '?')}${stderr ? ` — ${stderr}` : ''}` };
}

/**
 * Polls `background_jobs` for objectively-checkable completion conditions registered by a
 * Claude session (via `claw-job`). Runs `check_cmd`; exit 0 means done — posts `done_message`
 * to the originating thread. Purely mechanical: no LLM call in the polling loop.
 */
export class BackgroundJobScheduler {
  private readonly db: Database.Database;
  private readonly notify: (threadId: string, msg: string) => Promise<void>;
  /** Owner-only channel (simpleclaw) for things that must not go to an unverified thread. */
  private readonly notifyOwner: ((msg: string) => Promise<void>) | undefined;
  private readonly gc: AfterPollHook | undefined;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    db: Database.Database,
    notify: (threadId: string, msg: string) => Promise<void>,
    notifyOwner?: (msg: string) => Promise<void>,
    gc?: AfterPollHook,
  ) {
    this.db = db;
    this.notify = notify;
    this.notifyOwner = notifyOwner;
    this.gc = gc;
  }

  start(): void {
    // Run once immediately: a job registered just before a restart shouldn't wait a full interval.
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, POLL_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    log.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'background-jobs: started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll pass. Public so tests (and a manual trigger) can drive it deterministically. */
  async pollOnce(): Promise<void> {
    if (this.running) return; // a slow check_cmd must not stack overlapping polls
    this.running = true;
    try {
      await this.run();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'background-jobs: poll crashed');
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<void> {
    // Messages are collected per thread and flushed once, so several jobs finishing in the
    // same poll produce one post instead of a burst.
    const outbox = new Map<string, string[]>();
    const queue: Queue = (threadId, msg) => {
      const list = outbox.get(threadId) ?? [];
      list.push(msg);
      outbox.set(threadId, list);
    };
    const ownerOutbox: string[] = [];

    const jobs = getPendingBackgroundJobs(this.db);
    for (let i = 0; i < jobs.length; i += CHECK_CONCURRENCY) {
      await Promise.all(
        jobs.slice(i, i + CHECK_CONCURRENCY).map((job) => this.pollJob(job, queue, (m) => ownerOutbox.push(m))),
      );
    }

    await this.afterPoll(queue, (m) => ownerOutbox.push(m));

    for (const [threadId, msgs] of outbox) {
      for (const post of packMessages(msgs)) {
        await this.notify(threadId, post).catch((err) =>
          log.error({ err: (err as Error).message, threadId }, 'background-jobs: notify failed'),
        );
      }
    }
    if (ownerOutbox.length > 0) {
      if (this.notifyOwner) {
        for (const post of packMessages(ownerOutbox)) {
          await this.notifyOwner(post).catch((err) =>
            log.error({ err: (err as Error).message }, 'background-jobs: owner notify failed'),
          );
        }
      } else {
        log.warn({ messages: ownerOutbox }, 'background-jobs: owner notice with no owner channel');
      }
    }
  }

  /** Work that runs after every poll — the job GC. Its failure must not break polling. */
  private async afterPoll(queue: Queue, ownerQueue: (msg: string) => void): Promise<void> {
    if (!this.gc) return;
    try {
      await this.gc.afterPoll(queue, ownerQueue);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'background-jobs: gc pass crashed');
    }
  }

  private async pollJob(job: BackgroundJobRow, queue: Queue, ownerQueue: (msg: string) => void): Promise<void> {
    // Only jobs registered through claw-job (with a token issued for this very thread) may post.
    // A raw INSERT can name any thread — that's how any session could have written into any
    // thread — so it's refused, and the owner (not the named thread) is told.
    if (!job.runToken || !tokenBelongsToThread(this.db, job.runToken, job.threadId)) {
      markBackgroundJobStatus(this.db, job.id, 'failed');
      markBackgroundJobReaped(this.db, job.id);
      ownerQueue(
        `🚫 토큰 없이 등록된 백그라운드 작업 #${job.id}을 거부했습니다 (대상 스레드 <#${job.threadId}>, "${job.description}"). ` +
          '이제 claw-job CLI로만 등록할 수 있습니다 — 레포 플레이북/스킬에 sqlite INSERT 안내가 남아 있다면 교체가 필요합니다.',
      );
      return;
    }

    const expiresAt = parseDbUtc(job.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      markBackgroundJobStatus(this.db, job.id, 'expired');
      if (job.jobDir) {
        queue(
          job.threadId,
          `⏱️ job #${job.id} 만료 — 끝나지 않은 채 제한 시간을 넘겼습니다: ${job.description}${fencedTail(job.jobDir, 8)}`,
        );
      } else {
        const reason = job.lastError ? `\n마지막 확인 결과: ${job.lastError}` : '';
        queue(
          job.threadId,
          `⏱️ job #${job.id} 만료 — 완료를 확인하지 못했습니다: ${job.description}\n(조건: \`${job.checkCmd}\`)${reason}`,
        );
      }
      return;
    }

    if (job.jobDir && !job.expiryWarned && expiresAt - Date.now() <= EXPIRY_WARNING_MS) {
      markBackgroundJobExpiryWarned(this.db, job.id);
      queue(
        job.threadId,
        `⏳ job #${job.id} "${job.description}"이 30분 안에 만료됩니다. 아직 끝나지 않았고, 만료되면 종료 대상이 됩니다 — 더 필요하면 이 스레드에 "연장해줘"라고 해주세요.`,
      );
    }

    let outcome: CheckOutcome;
    try {
      await execAsync(job.checkCmd, { cwd: job.cwd, timeout: CHECK_TIMEOUT_MS });
      outcome = { kind: 'done' };
    } catch (err) {
      outcome = classifyCheckFailure(err);
    }

    if (outcome.kind === 'done') {
      const exit = job.jobDir ? readExitCode(job.jobDir) : null;
      if (exit !== null && exit !== 0) {
        markBackgroundJobStatus(this.db, job.id, 'failed');
        queue(job.threadId, `❌ job #${job.id} 실패 (exit ${exit}): ${job.description}${fencedTail(job.jobDir!, 15)}`);
        return;
      }
      markBackgroundJobStatus(this.db, job.id, 'done');
      queue(job.threadId, `✅ job #${job.id} 완료 — ${job.doneMessage}`);
      return;
    }

    const errorStreak = outcome.kind === 'broken' ? job.errorStreak + 1 : 0;
    let errorNotified = job.errorNotified;
    if (outcome.kind === 'broken' && errorStreak >= BROKEN_STREAK_THRESHOLD && !errorNotified) {
      errorNotified = true;
      queue(
        job.threadId,
        `⚠️ 백그라운드 작업 #${job.id}의 완료 조건 명령이 계속 실패합니다 (${errorStreak}회 연속) — 이대로면 완료를 감지할 수 없습니다: ${job.description}\n원인: ${outcome.detail}\n(조건: \`${job.checkCmd}\`, cwd: \`${job.cwd}\`)`,
      );
    }
    recordBackgroundJobCheck(this.db, job.id, { errorStreak, errorNotified, lastError: outcome.detail });
  }
}
