import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { log } from '../log.js';
import {
  type BackgroundJobRow,
  getPendingBackgroundJobs,
  markBackgroundJobStatus,
  parseDbUtc,
  recordBackgroundJobCheck,
} from '../state/background-jobs.js';

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 60 * 1_000;
const CHECK_TIMEOUT_MS = 30 * 1_000;
const CHECK_CONCURRENCY = 3;
/** Consecutive "the check itself is broken" results before we tell the thread. */
const BROKEN_STREAK_THRESHOLD = 3;

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
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: Database.Database, notify: (threadId: string, msg: string) => Promise<void>) {
    this.db = db;
    this.notify = notify;
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
    const jobs = getPendingBackgroundJobs(this.db);
    if (jobs.length === 0) return;

    // Messages are collected per thread and flushed once, so several jobs finishing in the
    // same poll produce one post instead of a burst.
    const outbox = new Map<string, string[]>();
    const queue = (threadId: string, msg: string): void => {
      const list = outbox.get(threadId) ?? [];
      list.push(msg);
      outbox.set(threadId, list);
    };

    for (let i = 0; i < jobs.length; i += CHECK_CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + CHECK_CONCURRENCY).map((job) => this.pollJob(job, queue)));
    }

    for (const [threadId, msgs] of outbox) {
      await this.notify(threadId, msgs.join('\n\n')).catch((err) =>
        log.error({ err: (err as Error).message, threadId }, 'background-jobs: notify failed'),
      );
    }
  }

  private async pollJob(job: BackgroundJobRow, queue: (threadId: string, msg: string) => void): Promise<void> {
    const expiresAt = parseDbUtc(job.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      markBackgroundJobStatus(this.db, job.id, 'expired');
      const reason = job.lastError ? `\n마지막 확인 결과: ${job.lastError}` : '';
      queue(
        job.threadId,
        `⏱️ 백그라운드 작업 시간 초과 — 완료를 확인하지 못했습니다: ${job.description}\n(조건: \`${job.checkCmd}\`)${reason}`,
      );
      return;
    }

    let outcome: CheckOutcome;
    try {
      await execAsync(job.checkCmd, { cwd: job.cwd, timeout: CHECK_TIMEOUT_MS });
      outcome = { kind: 'done' };
    } catch (err) {
      outcome = classifyCheckFailure(err);
    }

    if (outcome.kind === 'done') {
      markBackgroundJobStatus(this.db, job.id, 'done');
      queue(job.threadId, job.doneMessage);
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
