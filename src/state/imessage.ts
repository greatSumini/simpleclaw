import type Database from 'better-sqlite3';

export interface ImessageStateRow {
  lastRowId: number;
  lastPolledAt: string | null;
}

interface ImessageStateDbRow {
  last_row_id: number;
  last_polled_at: string | null;
}

export function getImessageState(db: Database.Database): ImessageStateRow | null {
  const stmt = db.prepare<[], ImessageStateDbRow>(
    'SELECT last_row_id, last_polled_at FROM imessage_state LIMIT 1',
  );
  const row = stmt.get();
  if (!row) return null;
  return { lastRowId: row.last_row_id, lastPolledAt: row.last_polled_at };
}

export function setImessageState(db: Database.Database, lastRowId: number): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO imessage_state (id, last_row_id, last_polled_at)
     VALUES (1, @lastRowId, @now)
     ON CONFLICT(id) DO UPDATE SET
       last_row_id    = excluded.last_row_id,
       last_polled_at = excluded.last_polled_at`,
  ).run({ lastRowId, now });
}
