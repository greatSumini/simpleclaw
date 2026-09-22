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
