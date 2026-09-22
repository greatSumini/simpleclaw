import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from '../state/migrations.js';
import { getBackgroundJob } from '../state/background-jobs.js';
import { issueRunToken, resolveRunToken, pruneRunTokens } from '../state/run-tokens.js';
import { BackgroundJobScheduler } from '../scheduler/background-jobs.js';
import { isSameProcessAlive, jobGroupMembers } from '../scheduler/job-process.js';
import { JobGarbageCollector, parseEtime } from '../scheduler/job-gc.js';
import { buildCommand, main, parseArgs, parseTtl, MIN_TTL_MS, MAX_TTL_MS, DEFAULT_TTL_MS } from '../cli/claw-job.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error('waitFor timed out');
}

describe('claw-job argument helpers', () => {
  test('parseTtl: default, units, clamping', () => {
    assert.equal(parseTtl(undefined).ms, DEFAULT_TTL_MS);
    assert.equal(parseTtl('3h').ms, 3 * 3_600_000);
    assert.equal(parseTtl('30m').ms, MIN_TTL_MS);
    assert.ok(parseTtl('30m').note);
    assert.equal(parseTtl('30d').ms, MAX_TTL_MS);
    assert.throws(() => parseTtl('soon'));
  });
  test('parseArgs: flags, positionals, and everything after --', () => {
    const a = parseArgs(['run', '--desc', 'x', '--ttl=3h', '--', 'echo', '--not-a-flag']);
    assert.equal(a.command, 'run');
    assert.deepEqual(a.flags, { desc: 'x', ttl: '3h' });
    assert.deepEqual(a.rest, ['echo', '--not-a-flag']);
  });
  test('buildCommand: one arg is a script, several are quoted argv', () => {
    assert.equal(buildCommand(['a && b']), 'a && b');
    assert.equal(buildCommand(['echo', "it's"]), `'echo' 'it'\\''s'`);
    assert.throws(() => buildCommand([]));
  });
});

describe('run tokens', () => {
  test('resolve works until expiry; pruning keeps tokens backing pending jobs', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const past = new Date(Date.now() - 10 * 24 * 3_600_000);
    const t = issueRunToken(db, { threadId: 'th', repo: 'r', authorIsOwner: true }, past);
    assert.equal(resolveRunToken(db, t), undefined); // expired
    const live = issueRunToken(db, { threadId: 'th', repo: 'r', authorIsOwner: true });
    assert.equal(resolveRunToken(db, live)?.threadId, 'th');
    const kept = issueRunToken(db, { threadId: 'th', repo: 'r', authorIsOwner: true }, past);
    db.prepare(
      `INSERT INTO background_jobs (thread_id, description, check_cmd, cwd, done_message, created_at, expires_at, run_token)
       VALUES ('th','d','false','/', 'm', ?, ?, ?)`,
    ).run(new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString(), kept);
    assert.equal(pruneRunTokens(db), 1); // `t` goes, `kept` stays
    assert.ok(db.prepare('SELECT 1 FROM run_tokens WHERE token = ?').get(kept));
  });
});

describe('claw-job end-to-end (real detached processes)', () => {
  let tmp: string;
  let dbFile: string;
  let db: Database.Database;
  let token: string;
  let env: NodeJS.ProcessEnv;
  const prevRoot = process.env['SIMPLECLAW_JOBS_ROOT'];

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-job-test-'));
    process.env['SIMPLECLAW_JOBS_ROOT'] = path.join(tmp, 'jobs');
    dbFile = path.join(tmp, 'test.db');
    db = new Database(dbFile);
    runMigrations(db);
    token = issueRunToken(db, { threadId: 'thread-1', repo: 'test/repo', authorIsOwner: true });
    env = { SIMPLECLAW_RUN_TOKEN: token, SIMPLECLAW_DB: dbFile };
  });

  after(() => {
    db.close();
    if (prevRoot === undefined) delete process.env['SIMPLECLAW_JOBS_ROOT'];
    else process.env['SIMPLECLAW_JOBS_ROOT'] = prevRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('without a token it refuses loudly', async () => {
    const r = await main(['list'], { SIMPLECLAW_DB: dbFile });
    assert.equal(r.code, 1);
    assert.match(r.out, /SIMPLECLAW_RUN_TOKEN/);
  });

  test('run: detached job survives its registrar, then the scheduler reports success', async () => {
    const r = await main(['run', '--desc', 'echo test', '--done', '끝남', '--cwd', tmp, '--', 'echo hello; sleep 1'], env);
    assert.equal(r.code, 0, r.out);
    const id = Number(r.out.match(/job #(\d+)/)![1]);
    const job = getBackgroundJob(db, id)!;
    assert.ok(job.pid);
    assert.ok(job.jobDir && fs.existsSync(path.join(job.jobDir, 'cmd.sh')));
    await waitFor(() => fs.existsSync(path.join(job.jobDir!, 'exit')));
    assert.match(fs.readFileSync(path.join(job.jobDir!, 'output.log'), 'utf8'), /hello/);

    const sent: Array<[string, string]> = [];
    await new BackgroundJobScheduler(db, async (t, m) => void sent.push([t, m])).pollOnce();
    assert.equal(getBackgroundJob(db, id)!.status, 'done');
    assert.deepEqual(sent.map(([t]) => t), ['thread-1']);
    assert.match(sent[0]![1], /완료 — 끝남/);
  });

  test('run: non-zero exit is reported as failure with the log tail', async () => {
    const r = await main(['run', '--desc', 'fails', '--done', 'x', '--cwd', tmp, '--', 'echo boom-marker >&2; exit 3'], env);
    assert.equal(r.code, 0, r.out);
    const id = Number(r.out.match(/job #(\d+)/)![1]);
    await waitFor(() => fs.existsSync(path.join(getBackgroundJob(db, id)!.jobDir!, 'exit')));
    const sent: string[] = [];
    await new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m)).pollOnce();
    assert.equal(getBackgroundJob(db, id)!.status, 'failed');
    assert.match(sent.join('\n'), /실패 \(exit 3\)/);
    assert.match(sent.join('\n'), /boom-marker/);
  });

  test('cancel kills the whole process group', async () => {
    const r = await main(['run', '--desc', 'long', '--done', 'x', '--cwd', tmp, '--', 'sleep 300 & sleep 300; wait'], env);
    assert.equal(r.code, 0, r.out);
    const id = Number(r.out.match(/job #(\d+)/)![1]);
    const job = getBackgroundJob(db, id)!;
    assert.ok(isSameProcessAlive(job.pid!, job.procStartedAt));
    const c = await main(['cancel', String(id)], env);
    assert.equal(c.code, 0, c.out);
    assert.equal(getBackgroundJob(db, id)!.status, 'cancelled');
    await waitFor(() => !isSameProcessAlive(job.pid!, job.procStartedAt));
  });

  test("status/cancel refuse another thread's job", async () => {
    const otherToken = issueRunToken(db, { threadId: 'thread-2', repo: 'test/repo', authorIsOwner: true });
    const r = await main(['watch', '--desc', 'w', '--check', 'false', '--done', 'x', '--cwd', tmp], env);
    const id = Number(r.out.match(/job #(\d+)/)![1]);
    const other = await main(['cancel', String(id)], { SIMPLECLAW_RUN_TOKEN: otherToken, SIMPLECLAW_DB: dbFile });
    assert.equal(other.code, 1);
    assert.match(other.out, /이 스레드의 작업이 아님/);
  });

  test('extend moves expiry and re-arms the warning', async () => {
    const r = await main(['watch', '--desc', 'w2', '--check', 'false', '--done', 'x', '--cwd', tmp, '--ttl', '2h'], env);
    const id = Number(r.out.match(/job #(\d+)/)![1]);
    const before = Date.parse(getBackgroundJob(db, id)!.expiresAt);
    const e = await main(['extend', String(id), '6h'], env);
    assert.equal(e.code, 0, e.out);
    assert.ok(Date.parse(getBackgroundJob(db, id)!.expiresAt) > before);
  });
});

describe('job GC', () => {
  let tmp: string;
  let db: Database.Database;
  let env: NodeJS.ProcessEnv;
  const prevRoot = process.env['SIMPLECLAW_JOBS_ROOT'];

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-gc-test-'));
    process.env['SIMPLECLAW_JOBS_ROOT'] = path.join(tmp, 'jobs');
    const dbFile = path.join(tmp, 'gc.db');
    db = new Database(dbFile);
    runMigrations(db);
    env = {
      SIMPLECLAW_RUN_TOKEN: issueRunToken(db, { threadId: 'gc-thread', repo: 'r', authorIsOwner: true }),
      SIMPLECLAW_DB: dbFile,
    };
  });

  after(() => {
    // make sure nothing from these tests outlives them
    for (const row of db.prepare('SELECT pid FROM background_jobs WHERE pid IS NOT NULL').all() as Array<{ pid: number }>) {
      try {
        process.kill(-row.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    db.close();
    if (prevRoot === undefined) delete process.env['SIMPLECLAW_JOBS_ROOT'];
    else process.env['SIMPLECLAW_JOBS_ROOT'] = prevRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function finishedJobWithLeftover(cmd: string): Promise<number> {
    const r = await main(['run', '--desc', 'leftover', '--done', 'x', '--cwd', tmp, '--', cmd], env);
    assert.equal(r.code, 0, r.out);
    const id = Number(r.out.match(/job #(\d+)/)![1]);
    await waitFor(() => fs.existsSync(path.join(getBackgroundJob(db, id)!.jobDir!, 'exit')));
    return id;
  }

  test('parseEtime', () => {
    assert.equal(parseEtime('05:03'), 303_000);
    assert.equal(parseEtime('02:00:00'), 7_200_000);
    assert.equal(parseEtime('3-01:00:00'), (3 * 24 + 1) * 3_600_000);
  });

  test('dry-run: leftover process is reported once, never killed', async () => {
    const id = await finishedJobWithLeftover('sleep 300 & exit 0');
    const gc = new JobGarbageCollector(db, { stateFile: path.join(tmp, 'gc-dry.json'), enforce: false });
    const sent: string[] = [];
    const s = new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m), async () => {}, gc);
    await s.pollOnce();
    await s.pollOnce();
    const job = getBackgroundJob(db, id)!;
    assert.equal(job.status, 'done');
    assert.equal(job.reaped, false);
    assert.ok(jobGroupMembers(job.pid!, job.procStartedAt).length > 0, 'leftover must still be alive');
    assert.equal(sent.filter((m) => m.includes('dry-run')).length, 1);
    process.kill(-job.pid!, 'SIGKILL');
  });

  test('enforce: leftover process group is killed and reported', async () => {
    const id = await finishedJobWithLeftover('sleep 300 & exit 0');
    const gc = new JobGarbageCollector(db, { stateFile: path.join(tmp, 'gc-on.json'), enforce: true });
    const sent: string[] = [];
    const owner: string[] = [];
    await new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m), async (m) => void owner.push(m), gc).pollOnce();
    const job = getBackgroundJob(db, id)!;
    assert.equal(job.reaped, true);
    await waitFor(() => jobGroupMembers(job.pid!, job.procStartedAt).length === 0);
    assert.match(sent.join('\n'), /남은 프로세스 1개를 종료/);
    assert.match(owner.join('\n'), /GC kill/);
  });

  test('enforce: a group with a browser-like process is left alone and reported', async () => {
    const id = await finishedJobWithLeftover("bash -c 'exec -a fake-chrome-helper sleep 300' & exit 0");
    const gc = new JobGarbageCollector(db, { stateFile: path.join(tmp, 'gc-on2.json'), enforce: true });
    const sent: string[] = [];
    await new BackgroundJobScheduler(db, async (_t, m) => void sent.push(m), async () => {}, gc).pollOnce();
    const job = getBackgroundJob(db, id)!;
    assert.equal(job.reaped, true);
    assert.ok(jobGroupMembers(job.pid!, job.procStartedAt).length > 0, 'browser-like process must survive');
    assert.match(sent.join('\n'), /자동 정리를 보류/);
    process.kill(-job.pid!, 'SIGKILL');
  });
});
