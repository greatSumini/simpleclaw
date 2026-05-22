import type Database from 'better-sqlite3';

export interface SkillProposal {
  id: number;
  ts: string;
  kind: 'simpleclaw' | 'repo';
  name: string;
  description: string;
  content: string;
  repoFullName: string | null;
  sourceThreadId: string | null;
  status: 'pending' | 'created' | 'dismissed';
}

interface SkillProposalDbRow {
  id: number;
  ts: string;
  kind: string;
  name: string;
  description: string;
  content: string;
  repo_full_name: string | null;
  source_thread_id: string | null;
  status: string;
}

function fromRow(row: SkillProposalDbRow): SkillProposal {
  // Backwards compat: legacy rows stored kind='claw' before the SimpleClaw rename.
  const kind = row.kind === 'claw' ? 'simpleclaw' : (row.kind as 'simpleclaw' | 'repo');
  return {
    id: row.id,
    ts: row.ts,
    kind,
    name: row.name,
    description: row.description,
    content: row.content,
    repoFullName: row.repo_full_name,
    sourceThreadId: row.source_thread_id,
    status: row.status as 'pending' | 'created' | 'dismissed',
  };
}

export interface InsertSkillProposalArgs {
  kind: 'simpleclaw' | 'repo';
  name: string;
  description: string;
  content: string;
  repoFullName?: string;
  sourceThreadId?: string;
}

export function insertSkillProposal(
  db: Database.Database,
  args: InsertSkillProposalArgs,
): number {
  const ts = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO skill_proposals (ts, kind, name, description, content, repo_full_name, source_thread_id, status)
     VALUES (@ts, @kind, @name, @description, @content, @repoFullName, @sourceThreadId, 'pending')`,
  );
  const result = stmt.run({
    ts,
    kind: args.kind,
    name: args.name,
    description: args.description,
    content: args.content,
    repoFullName: args.repoFullName ?? null,
    sourceThreadId: args.sourceThreadId ?? null,
  });
  return result.lastInsertRowid as number;
}

export function getSkillProposal(
  db: Database.Database,
  id: number,
): SkillProposal | null {
  const stmt = db.prepare<[number], SkillProposalDbRow>(
    'SELECT * FROM skill_proposals WHERE id = ?',
  );
  const row = stmt.get(id);
  return row ? fromRow(row) : null;
}

export function updateSkillProposalStatus(
  db: Database.Database,
  id: number,
  status: 'created' | 'dismissed',
): void {
  const stmt = db.prepare<[string, number]>(
    'UPDATE skill_proposals SET status = ? WHERE id = ?',
  );
  stmt.run(status, id);
}
