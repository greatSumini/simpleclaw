import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Per-engine-run capability tokens.
 *
 * The worker issues one right before spawning an engine and hands it over through the
 * `SIMPLECLAW_RUN_TOKEN` env var. `claw-job` presents it to register background jobs, and the
 * token — not anything the model typed — decides which thread the job reports to. This closes
 * two gaps of the old raw-INSERT instruction: the model never knew its own thread id, and any
 * session could post into any thread by inserting an arbitrary thread_id.
 */

export interface RunTokenRow {
  token: string;
  threadId: string;
  repo: string;
  authorIsOwner: boolean;
  createdAt: string;
  expiresAt: string;
}

interface RunTokenDbRow {
  token: string;
  thread_id: string;
  repo: string;
  author_is_owner: number;
  created_at: string;
  expires_at: string;
}

/** Longer than the 1h engine timeout, so a job registered at the very end of a turn still validates. */
export const RUN_TOKEN_TTL_MS = 3 * 60 * 60 * 1_000;

export function issueRunToken(
  db: Database.Database,
  args: { threadId: string; repo: string; authorIsOwner: boolean },
  now: Date = new Date(),
): string {
  const token = randomBytes(18).toString('base64url');
  db.prepare(
    `INSERT INTO run_tokens (token, thread_id, repo, author_is_owner, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    args.threadId,
    args.repo,
    args.authorIsOwner ? 1 : 0,
    now.toISOString(),
    new Date(now.getTime() + RUN_TOKEN_TTL_MS).toISOString(),
  );
  return token;
}

/** Returns the token's run context, or undefined if unknown or expired. */
export function resolveRunToken(
  db: Database.Database,
  token: string,
  now: Date = new Date(),
): RunTokenRow | undefined {
  const row = db.prepare<[string], RunTokenDbRow>('SELECT * FROM run_tokens WHERE token = ?').get(token);
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= now.getTime()) return undefined;
  return {
    token: row.token,
    threadId: row.thread_id,
    repo: row.repo,
    authorIsOwner: row.author_is_owner === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Whether a token was ever issued for this thread (expiry ignored — used to vet stored jobs). */
export function tokenBelongsToThread(db: Database.Database, token: string, threadId: string): boolean {
  const row = db
    .prepare<[string], { thread_id: string }>('SELECT thread_id FROM run_tokens WHERE token = ?')
    .get(token);
  return row?.thread_id === threadId;
}

/**
 * Drop tokens expired for more than a day — except those still backing a pending job, which
 * the scheduler re-vets on every poll (a `run` job can outlive its token by days).
 */
export function pruneRunTokens(db: Database.Database, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  return db
    .prepare(
      `DELETE FROM run_tokens
        WHERE expires_at < ?
          AND token NOT IN (SELECT run_token FROM background_jobs WHERE status = 'pending' AND run_token IS NOT NULL)`,
    )
    .run(cutoff).changes;
}
