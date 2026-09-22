import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Process / job-directory helpers shared by `claw-job` (spawn, cancel) and the job GC.
 *
 * Everything that can kill is identity-checked: a pid alone may have been recycled, so a
 * process is only "ours" if its start time matches what we recorded at spawn (or, for group
 * members, if it started no earlier than the job's leader).
 */

/**
 * Root for detached job directories. GC never deletes anything outside it.
 * Read at call time so tests can point it at a temp dir (SIMPLECLAW_JOBS_ROOT).
 */
export function jobsRoot(): string {
  return process.env['SIMPLECLAW_JOBS_ROOT'] ?? path.join(os.homedir(), '.simpleclaw', 'jobs');
}

/**
 * Processes that may be shared across sessions (a browser another session is still driving).
 * GC never kills a group containing one of these — it reports and leaves it alone.
 */
export const SHARED_DAEMON_PATTERN = /chrome|chromium|browser[_-]?harness|browser-use|playwright/i;

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `ps -o lstart=` for a pid, or null if the process doesn't exist. */
export function procStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Alive AND the same process we spawned (not a recycled pid). */
export function isSameProcessAlive(pid: number, startedAt: string | null): boolean {
  const now = procStartTime(pid);
  if (!now) return false;
  return startedAt === null ? true : now === startedAt;
}

export interface GroupMember {
  pid: number;
  startedAt: string;
  command: string;
}

/** Live members of a process group, each with its start time. */
export function groupMembers(pgid: number): GroupMember[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,pgid=,lstart=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const members: GroupMember[] = [];
  for (const line of out.split('\n')) {
    // pid pgid <lstart: 5 tokens, e.g. "Fri Sep 18 14:40:52 2026"> command...
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (!m || Number(m[2]) !== pgid) continue;
    members.push({ pid: Number(m[1]), startedAt: m[3]!.replace(/\s+/g, ' '), command: m[4]! });
  }
  return members;
}

/**
 * Members of the job's group that provably belong to the job: started no earlier than the
 * recorded leader start time. Guards against a recycled pgid after the original group emptied.
 */
export function jobGroupMembers(pgid: number, leaderStartedAt: string | null): GroupMember[] {
  const members = groupMembers(pgid);
  if (!leaderStartedAt) return members;
  const floor = Date.parse(leaderStartedAt.replace(/\s+/g, ' '));
  if (!Number.isFinite(floor)) return members;
  return members.filter((m) => {
    const t = Date.parse(m.startedAt);
    return Number.isFinite(t) && t >= floor;
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the whole group, then SIGKILL whatever is still there after the grace period. */
export async function killGroup(pgid: number, graceMs = 30_000): Promise<void> {
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return; // group already gone
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (groupMembers(pgid).length === 0) return;
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // raced with exit
  }
}

export function readExitCode(jobDir: string): number | null {
  try {
    const n = Number.parseInt(fs.readFileSync(path.join(jobDir, 'exit'), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function tailLog(jobDir: string, lines: number): string {
  try {
    const fd = fs.openSync(path.join(jobDir, 'output.log'), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8').split('\n').filter((l) => l.trim() !== '').slice(-lines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Leftovers a kill may have produced, so the notice can say what needs manual cleanup
 * instead of the next session tripping over it.
 */
export function residueReport(cwd: string): string[] {
  const found: string[] = [];
  try {
    if (fs.existsSync(path.join(cwd, '.git', 'index.lock'))) found.push(`${path.join(cwd, '.git', 'index.lock')} (git 잠금 — 다른 git 작업이 없으면 삭제 필요)`);
    const cutoff = Date.now() - 60 * 60 * 1_000;
    for (const name of fs.readdirSync(cwd)) {
      if (!/\.(part|partial|tmp|temp|download)$/i.test(name)) continue;
      const st = fs.statSync(path.join(cwd, name));
      if (st.isFile() && st.mtimeMs >= cutoff) found.push(`${path.join(cwd, name)} (작성 중이던 파일로 보임)`);
      if (found.length >= 6) break;
    }
  } catch {
    // cwd gone or unreadable — nothing to report
  }
  return found;
}

/** Resolve a job dir and confirm it really sits under JOBS_ROOT (no symlink escapes). */
export function safeJobDir(dir: string): string | null {
  try {
    const real = fs.realpathSync(dir);
    const root = fs.realpathSync(jobsRoot());
    return real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
}

export function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) total += dirSizeBytes(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
    }
  } catch {
    // ignore
  }
  return total;
}
