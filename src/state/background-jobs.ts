import type Database from 'better-sqlite3';

export interface BackgroundJobRow {
  id: number;
  threadId: string;
  description: string;
  checkCmd: string;
  cwd: string;
  doneMessage: string;
  status: 'pending' | 'done' | 'expired';
  createdAt: string;
  checkedAt: string | null;
  expiresAt: string;
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
}

function fromRow(row: BackgroundJobDbRow): BackgroundJobRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    description: row.description,
    checkCmd: row.check_cmd,
    cwd: row.cwd,
    doneMessage: row.done_message,
    status: row.status as BackgroundJobRow['status'],
    createdAt: row.created_at,
    checkedAt: row.checked_at,
    expiresAt: row.expires_at,
  };
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
  status: 'done' | 'expired',
): void {
  db.prepare('UPDATE background_jobs SET status = ?, checked_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    id,
  );
}
