import type Database from 'better-sqlite3';

export interface SessionRow {
  threadId: string;
  claudeSessionId: string;
  repo: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionDbRow {
  thread_id: string;
  claude_session_id: string;
  repo: string;
  cwd: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: SessionDbRow): SessionRow {
  return {
    threadId: row.thread_id,
    claudeSessionId: row.claude_session_id,
    repo: row.repo,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSession(db: Database.Database, threadId: string): SessionRow | null {
  if (!threadId) throw new Error('getSession: threadId is required');
  const stmt = db.prepare<[string], SessionDbRow>(
    'SELECT thread_id, claude_session_id, repo, cwd, created_at, updated_at FROM sessions WHERE thread_id = ?',
  );
  const row = stmt.get(threadId);
  return row ? fromRow(row) : null;
}

export interface UpsertSessionArgs {
  threadId: string;
  claudeSessionId: string;
  repo: string;
  cwd: string;
}

export function upsertSession(db: Database.Database, args: UpsertSessionArgs): void {
  if (!args.threadId) throw new Error('upsertSession: threadId is required');
  if (!args.claudeSessionId) throw new Error('upsertSession: claudeSessionId is required');
  if (!args.repo) throw new Error('upsertSession: repo is required');
  if (!args.cwd) throw new Error('upsertSession: cwd is required');

  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO sessions (thread_id, claude_session_id, repo, cwd, created_at, updated_at)
     VALUES (@threadId, @claudeSessionId, @repo, @cwd, @now, @now)
     ON CONFLICT(thread_id) DO UPDATE SET
       claude_session_id = excluded.claude_session_id,
       repo              = excluded.repo,
       cwd               = excluded.cwd,
       created_at        = COALESCE(sessions.created_at, excluded.created_at),
       updated_at        = excluded.updated_at`,
  );

  stmt.run({
    threadId: args.threadId,
    claudeSessionId: args.claudeSessionId,
    repo: args.repo,
    cwd: args.cwd,
    now,
  });
}

export function deleteSession(db: Database.Database, threadId: string): void {
  if (!threadId) throw new Error('deleteSession: threadId is required');
  const stmt = db.prepare<[string]>('DELETE FROM sessions WHERE thread_id = ?');
  stmt.run(threadId);
}

export function listRecentSessions(db: Database.Database, limit = 50): SessionRow[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('listRecentSessions: limit must be a positive integer');
  }
  const stmt = db.prepare<[number], SessionDbRow>(
    'SELECT thread_id, claude_session_id, repo, cwd, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?',
  );
  const rows = stmt.all(limit);
  return rows.map(fromRow);
}
