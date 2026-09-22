import type Database from 'better-sqlite3';

export type BackgroundJobStatus = 'pending' | 'done' | 'expired' | 'failed' | 'cancelled';

export interface BackgroundJobRow {
  id: number;
  threadId: string;
  description: string;
  checkCmd: string;
  cwd: string;
  doneMessage: string;
  status: BackgroundJobStatus;
  createdAt: string;
  checkedAt: string | null;
  expiresAt: string;
  attempts: number;
  errorStreak: number;
  errorNotified: boolean;
  lastError: string | null;
  /** Token of the engine run that registered this job (null = legacy raw INSERT). */
  runToken: string | null;
  /** Detached `claw-job run` process (process-group leader). Null for `watch` jobs. */
  pid: number | null;
  /** `ps -o lstart=` of `pid` at spawn — guards against acting on a recycled pid. */
  procStartedAt: string | null;
  /** Directory with cmd.sh / output.log / exit for `run` jobs. */
  jobDir: string | null;
  expiryWarned: boolean;
  /** GC has dealt with this job's process group (killed, or confirmed gone). */
  reaped: boolean;
}

interface BackgroundJobDbRow {
  id: number;
  thread_id: string;
  description: string;
  check_cmd: string;
  cwd: string;
  done_message: string;
  status: string;
  created_at: string;
  checked_at: string | null;
  expires_at: string;
  attempts: number;
  error_streak: number;
  error_notified: number;
  last_error: string | null;
  run_token: string | null;
  pid: number | null;
  proc_started_at: string | null;
  job_dir: string | null;
  expiry_warned: number;
  reaped: number;
}

function fromRow(row: BackgroundJobDbRow): BackgroundJobRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    description: row.description,
    checkCmd: row.check_cmd,
    cwd: row.cwd,
    doneMessage: row.done_message,
    status: row.status as BackgroundJobStatus,
    createdAt: row.created_at,
    checkedAt: row.checked_at,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    errorStreak: row.error_streak,
    errorNotified: row.error_notified === 1,
    lastError: row.last_error,
    runToken: row.run_token,
    pid: row.pid,
    procStartedAt: row.proc_started_at,
    jobDir: row.job_dir,
    expiryWarned: row.expiry_warned === 1,
    reaped: row.reaped === 1,
  };
}

/**
 * Parse a timestamp stored in SQLite as UTC epoch ms.
 *
 * SQLite's `datetime('now', ...)` yields `2026-09-17 22:30:53` — UTC, but with no zone marker.
 * `new Date()` reads that form as *local* time, so on a KST host every such expires_at landed
 * 9 hours early and any TTL ≤ 9h expired on the very first poll (4 of the first 7 jobs died
 * this way). Anything without an explicit zone is therefore forced to UTC here.
 */
export function parseDbUtc(value: string): number {
  const s = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return Date.parse(s);
  return Date.parse(`${s.replace(' ', 'T')}Z`);
}

export function getPendingBackgroundJobs(db: Database.Database): BackgroundJobRow[] {
  const rows = db
    .prepare<[], BackgroundJobDbRow>("SELECT * FROM background_jobs WHERE status = 'pending' ORDER BY id ASC")
    .all();
  return rows.map(fromRow);
}

export function markBackgroundJobStatus(
  db: Database.Database,
  id: number,
  status: Exclude<BackgroundJobStatus, 'pending'>,
): void {
  db.prepare('UPDATE background_jobs SET status = ?, checked_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    id,
  );
}

/** Record one poll of a still-pending job (attempt count, failure streak, last error). */
export function recordBackgroundJobCheck(
  db: Database.Database,
  id: number,
  state: { errorStreak: number; errorNotified: boolean; lastError: string | null },
): void {
  db.prepare(
    `UPDATE background_jobs
        SET attempts = attempts + 1, checked_at = ?, error_streak = ?, error_notified = ?, last_error = ?
      WHERE id = ?`,
  ).run(new Date().toISOString(), state.errorStreak, state.errorNotified ? 1 : 0, state.lastError, id);
}

export function getPendingBackgroundJobsForThread(db: Database.Database, threadId: string): BackgroundJobRow[] {
  const rows = db
    .prepare<[string], BackgroundJobDbRow>(
      "SELECT * FROM background_jobs WHERE status = 'pending' AND thread_id = ? ORDER BY id ASC",
    )
    .all(threadId);
  return rows.map(fromRow);
}

export function getBackgroundJob(db: Database.Database, id: number): BackgroundJobRow | undefined {
  const row = db.prepare<[number], BackgroundJobDbRow>('SELECT * FROM background_jobs WHERE id = ?').get(id);
  return row ? fromRow(row) : undefined;
}

export function listBackgroundJobsForThread(
  db: Database.Database,
  threadId: string,
  limit = 20,
): BackgroundJobRow[] {
  return db
    .prepare<[string, number], BackgroundJobDbRow>(
      'SELECT * FROM background_jobs WHERE thread_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(threadId, limit)
    .map(fromRow);
}

export interface NewBackgroundJob {
  threadId: string;
  description: string;
  checkCmd: string;
  cwd: string;
  doneMessage: string;
  expiresAt: Date;
  runToken: string;
}

export function insertBackgroundJob(db: Database.Database, job: NewBackgroundJob): number {
  const now = new Date();
  if (job.expiresAt.getTime() <= now.getTime()) {
    throw new Error('expires_at must be in the future');
  }
  const r = db
    .prepare(
      `INSERT INTO background_jobs
         (thread_id, description, check_cmd, cwd, done_message, created_at, expires_at, run_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.threadId,
      job.description,
      job.checkCmd,
      job.cwd,
      job.doneMessage,
      now.toISOString(),
      job.expiresAt.toISOString(),
      job.runToken,
    );
  return Number(r.lastInsertRowid);
}

export function setBackgroundJobProcess(
  db: Database.Database,
  id: number,
  proc: { checkCmd: string; pid: number; procStartedAt: string | null; jobDir: string },
): void {
  db.prepare(
    'UPDATE background_jobs SET check_cmd = ?, pid = ?, proc_started_at = ?, job_dir = ? WHERE id = ?',
  ).run(proc.checkCmd, proc.pid, proc.procStartedAt, proc.jobDir, id);
}

export function setBackgroundJobExpiry(db: Database.Database, id: number, expiresAt: Date): void {
  db.prepare('UPDATE background_jobs SET expires_at = ?, expiry_warned = 0 WHERE id = ?').run(
    expiresAt.toISOString(),
    id,
  );
}

export function markBackgroundJobExpiryWarned(db: Database.Database, id: number): void {
  db.prepare('UPDATE background_jobs SET expiry_warned = 1 WHERE id = ?').run(id);
}

/** Finished (non-pending) `run` jobs whose process group GC hasn't dealt with yet. */
export function getUnreapedFinishedRunJobs(db: Database.Database): BackgroundJobRow[] {
  return db
    .prepare<[], BackgroundJobDbRow>(
      "SELECT * FROM background_jobs WHERE status != 'pending' AND pid IS NOT NULL AND reaped = 0 ORDER BY id ASC",
    )
    .all()
    .map(fromRow);
}

export function markBackgroundJobReaped(db: Database.Database, id: number): void {
  db.prepare('UPDATE background_jobs SET reaped = 1 WHERE id = ?').run(id);
}

/** Pending `run` jobs whose process is (supposedly) alive — used for the concurrency cap. */
export function getPendingRunJobs(db: Database.Database): BackgroundJobRow[] {
  return db
    .prepare<[], BackgroundJobDbRow>(
      "SELECT * FROM background_jobs WHERE status = 'pending' AND pid IS NOT NULL ORDER BY id ASC",
    )
    .all()
    .map(fromRow);
}

/** Terminal jobs older than the cutoff — candidates for row + job-dir cleanup. */
export function getOldFinishedJobs(db: Database.Database, olderThan: Date): BackgroundJobRow[] {
  return db
    .prepare<[], BackgroundJobDbRow>("SELECT * FROM background_jobs WHERE status != 'pending' ORDER BY id ASC")
    .all()
    .map(fromRow)
    .filter((j) => {
      const t = parseDbUtc(j.checkedAt ?? j.createdAt);
      return Number.isFinite(t) && t < olderThan.getTime();
    });
}

export function deleteBackgroundJob(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM background_jobs WHERE id = ?').run(id);
}
