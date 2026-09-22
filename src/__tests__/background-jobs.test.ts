import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../state/migrations.js';
import { parseDbUtc, getPendingBackgroundJobs } from '../state/background-jobs.js';
import { issueRunToken } from '../state/run-tokens.js';
import { BackgroundJobScheduler, classifyCheckFailure, packMessages } from '../scheduler/background-jobs.js';
import { formatEngineFailure } from '../adapters/discord.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertJob(
  db: Database.Database,
  fields: { checkCmd: string; cwd?: string; expiresAt: string; createdAt?: string; threadId?: string; token?: string | null },
): number {
  const threadId = fields.threadId ?? 't1';
  const token =
    fields.token === undefined ? issueRunToken(db, { threadId, repo: 'test/repo', authorIsOwner: true }) : fields.token;
  const r = db
    .prepare(
      `INSERT INTO background_jobs (thread_id, description, check_cmd, cwd, done_message, created_at, expires_at, run_token)
       VALUES (?, 'desc', ?, ?, 'DONE', ?, ?, ?)`,
    )
    .run(threadId, fields.checkCmd, fields.cwd ?? os.tmpdir(), fields.createdAt ?? new Date().toISOString(), fields.expiresAt, token);
  return Number(r.lastInsertRowid);
}

function status(db: Database.Database, id: number): string {
  return (db.prepare('SELECT status FROM background_jobs WHERE id = ?').get(id) as { status: string }).status;
}

describe('parseDbUtc', () => {
  test('SQLite datetime() output (no zone) is read as UTC, not local time', () => {
    assert.equal(parseDbUtc('2026-09-17 22:30:53'), Date.UTC(2026, 8, 17, 22, 30, 53));
  });
  test('ISO with Z is unchanged', () => {
    assert.equal(parseDbUtc('2026-09-08T20:42:41Z'), Date.UTC(2026, 8, 8, 20, 42, 41));
  });
  test('explicit offset is honoured', () => {
    assert.equal(parseDbUtc('2026-09-17T22:30:53+09:00'), Date.UTC(2026, 8, 17, 13, 30, 53));
  });
  test('regression: job7 from 2026-09-17 no longer expires before it was created', () => {
    assert.ok(parseDbUtc('2026-09-17 22:30:53') > parseDbUtc('2026-09-17 14:30:53'));
  });
});

describe('classifyCheckFailure', () => {
  test('plain exit 1 means "not yet"', () => {
    assert.equal(classifyCheckFailure({ code: 1, stderr: '' }).kind, 'not-yet');
  });
  test('command not found (127) is broken', () => {
    assert.equal(classifyCheckFailure({ code: 127, stderr: 'sh: foo: command not found' }).kind, 'broken');
  });
  test('spawn failure (missing cwd) is broken', () => {
    assert.equal(classifyCheckFailure({ code: 'ENOENT', message: 'spawn /bin/sh ENOENT' }).kind, 'broken');
  });
  test('timeout kill is broken', () => {
    assert.equal(classifyCheckFailure({ killed: true, signal: 'SIGTERM', code: null }).kind, 'broken');
  });
});

describe('BackgroundJobScheduler.pollOnce', () => {
  const future = (): string => new Date(Date.now() + 3_600_000).toISOString();

  test('a job registered with SQLite datetime() format is checked, not insta-expired', async () => {
    const db = freshDb();
    const token = issueRunToken(db, { threadId: 't1', repo: 'r', authorIsOwner: true });
    db.prepare(
      `INSERT INTO background_jobs (thread_id, description, check_cmd, cwd, done_message, created_at, expires_at, run_token)
       VALUES ('t1', 'd', 'true', ?, 'DONE', datetime('now'), datetime('now', '+2 hours'), ?)`,
    ).run(os.tmpdir(), token);
    const sent: string[] = [];
    await new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m)).pollOnce();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /완료 — DONE/);
  });

  test('raw INSERT without a token is refused and reported to the owner, not the thread', async () => {
    const db = freshDb();
    const id = insertJob(db, { checkCmd: 'true', expiresAt: future(), token: null });
    const sent: string[] = [];
    const owner: string[] = [];
    await new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m), async (m) => void owner.push(m)).pollOnce();
    assert.equal(status(db, id), 'failed');
    assert.equal(sent.length, 0);
    assert.match(owner[0]!, /토큰 없이/);
  });

  test("a token issued for another thread can't be used to post here", async () => {
    const db = freshDb();
    const other = issueRunToken(db, { threadId: 'other-thread', repo: 'r', authorIsOwner: false });
    const id = insertJob(db, { checkCmd: 'true', expiresAt: future(), token: other });
    const sent: string[] = [];
    await new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m), async () => {}).pollOnce();
    assert.equal(status(db, id), 'failed');
    assert.equal(sent.length, 0);
  });

  test('done → status done + done_message posted', async () => {
    const db = freshDb();
    const id = insertJob(db, { checkCmd: 'true', expiresAt: future() });
    const sent: Array<[string, string]> = [];
    await new BackgroundJobScheduler(db, async (t, m) => void sent.push([t, m])).pollOnce();
    assert.equal(status(db, id), 'done');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]![0], 't1');
    assert.match(sent[0]![1], new RegExp(`job #${id} 완료 — DONE`));
  });

  test('not-yet stays pending silently and counts attempts', async () => {
    const db = freshDb();
    const id = insertJob(db, { checkCmd: 'false', expiresAt: future() });
    const sent: string[] = [];
    const s = new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m));
    await s.pollOnce();
    await s.pollOnce();
    assert.equal(status(db, id), 'pending');
    assert.equal(sent.length, 0);
    assert.equal((db.prepare('SELECT attempts FROM background_jobs WHERE id = ?').get(id) as { attempts: number }).attempts, 2);
  });

  test('broken check is reported exactly once after 3 consecutive failures', async () => {
    const db = freshDb();
    insertJob(db, { checkCmd: 'definitely-not-a-command-xyz', expiresAt: future() });
    const sent: string[] = [];
    const s = new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m));
    for (let i = 0; i < 5; i++) await s.pollOnce();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /완료 조건 명령이 계속 실패/);
  });

  test('missing cwd is treated as broken', async () => {
    const db = freshDb();
    insertJob(db, { checkCmd: 'true', cwd: path.join(os.tmpdir(), 'no-such-dir-claw-test'), expiresAt: future() });
    const sent: string[] = [];
    const s = new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m));
    for (let i = 0; i < 3; i++) await s.pollOnce();
    assert.equal(sent.length, 1);
  });

  test('expired job → status expired with last error attached', async () => {
    const db = freshDb();
    const id = insertJob(db, { checkCmd: 'false', expiresAt: new Date(Date.now() - 1000).toISOString() });
    const sent: string[] = [];
    await new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m)).pollOnce();
    assert.equal(status(db, id), 'expired');
    assert.match(sent[0]!, /만료 — 완료를 확인하지 못했습니다/);
  });

  test('several jobs finishing in one poll → one message per thread', async () => {
    const db = freshDb();
    insertJob(db, { checkCmd: 'true', expiresAt: future() });
    insertJob(db, { checkCmd: 'true', expiresAt: future() });
    insertJob(db, { checkCmd: 'true', expiresAt: future(), threadId: 't2' });
    const sent: Array<[string, string]> = [];
    await new BackgroundJobScheduler(db, async (t, m) => void sent.push([t, m])).pollOnce();
    assert.equal(sent.length, 2);
    assert.equal(getPendingBackgroundJobs(db).length, 0);
  });
});

describe('packMessages', () => {
  test('joins small messages into one post', () => {
    assert.deepEqual(packMessages(['a', 'b']), ['a\n\nb']);
  });
  test('never produces a post over the Discord limit', () => {
    const posts = packMessages(['x'.repeat(1500), 'y'.repeat(1500), 'z'.repeat(5000)]);
    assert.equal(posts.length, 3);
    for (const p of posts) assert.ok(p.length <= 1900);
  });
});

describe('formatEngineFailure', () => {
  test('timeout → Korean resume guidance, no raw ms', () => {
    const msg = formatEngineFailure('claude run exceeded timeout 3600000ms', 3_600_000);
    assert.match(msg, /60분/);
    assert.match(msg, /이어서/);
    assert.doesNotMatch(msg, /3600000/);
  });
  test('lists pending background jobs', () => {
    const msg = formatEngineFailure('claude exited with code 1', 3_600_000, [{ id: 3, description: '전사' }]);
    assert.match(msg, /#3 전사/);
  });
});

