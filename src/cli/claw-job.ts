/**
 * claw-job — the only supported way for an engine session to get a follow-up after its turn ends.
 *
 * A SimpleClaw turn is synchronous: once the reply is sent the session is gone, and anything it
 * started in the shell may die with it. So a session that can't finish in-turn registers here:
 *
 *   run    detach a long command from the session (own process group, nice 10, log + exit code
 *          in ~/.simpleclaw/jobs/<id>/); SimpleClaw reports success/failure to the thread.
 *   watch  wait for an external condition (`--check` exits 0) and report it.
 *
 * The thread to report to comes from SIMPLECLAW_RUN_TOKEN (issued per engine run by the worker),
 * never from arguments — the model can't know its thread id, and must not be able to pick one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  type BackgroundJobRow,
  getBackgroundJob,
  getPendingRunJobs,
  insertBackgroundJob,
  listBackgroundJobsForThread,
  markBackgroundJobReaped,
  markBackgroundJobStatus,
  parseDbUtc,
  setBackgroundJobExpiry,
  setBackgroundJobProcess,
} from '../state/background-jobs.js';
import { type RunTokenRow, resolveRunToken } from '../state/run-tokens.js';
import {
  jobsRoot,
  isSameProcessAlive,
  killGroup,
  procStartTime,
  readExitCode,
  shq,
  tailLog,
} from '../scheduler/job-process.js';

export const MIN_TTL_MS = 2 * 60 * 60 * 1_000;
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1_000;
/** Detached jobs allowed to run at once (they are usually ffmpeg / whisper — CPU-heavy). */
export const MAX_CONCURRENT_RUN_JOBS = 3;

const USAGE = `claw-job — 턴이 끝난 뒤에도 이어지는 작업을 SimpleClaw에 맡긴다

  claw-job run   --desc <설명> --done <완료 메시지> [--ttl 12h] [--cwd <dir>] -- <명령>
      명령을 세션과 분리해 실행 (nice 10, 로그·종료코드 기록). 끝나면 성공/실패를 스레드에 자동 알림.
      <명령>이 인자 하나면 bash 스크립트 문자열로, 여러 개면 인자 그대로 실행.
  claw-job watch --desc <설명> --check <exit 0이면 완료인 명령> --done <완료 메시지> [--ttl 12h] [--cwd <dir>]
      외부 조건(파일 생성, PR merge, HTTP 200 등)을 60초마다 확인해 충족되면 알림.
  claw-job list                 이 스레드의 작업 목록
  claw-job status <id>          상태 + 로그 끝부분
  claw-job extend <id> <ttl>    만료 연장 (지금부터 <ttl>, 예: 6h)
  claw-job cancel <id>          취소 (run 작업은 프로세스 그룹 종료)

  ttl: 30m / 12h / 2d 형식. ${MIN_TTL_MS / 3_600_000}h 미만은 ${MIN_TTL_MS / 3_600_000}h로, ${MAX_TTL_MS / 86_400_000}d 초과는 ${MAX_TTL_MS / 86_400_000}d로 조정.`;

class CliError extends Error {}

export function parseTtl(s: string | undefined): { ms: number; note?: string } {
  if (s === undefined) return { ms: DEFAULT_TTL_MS };
  const m = s.trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!m) throw new CliError(`ttl 형식이 잘못됨: "${s}" (예: 30m, 12h, 2d)`);
  const unit = m[2]!.toLowerCase();
  const ms = Number(m[1]) * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
  if (ms < MIN_TTL_MS) return { ms: MIN_TTL_MS, note: `ttl ${s} → 최소값 ${MIN_TTL_MS / 3_600_000}h로 조정` };
  if (ms > MAX_TTL_MS) return { ms: MAX_TTL_MS, note: `ttl ${s} → 최대값 ${MAX_TTL_MS / 86_400_000}d로 조정` };
  return { ms };
}

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
  /** Everything after `--` (run's command). */
  rest: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...tail] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a === '--') {
      rest = tail.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const v = tail[i + 1];
        if (v === undefined || v.startsWith('--')) throw new CliError(`${a} 에 값이 필요함`);
        flags[a.slice(2)] = v;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags, rest };
}

/** One arg = a bash script string; several = argv to run verbatim. */
export function buildCommand(rest: string[]): string {
  if (rest.length === 0) throw new CliError('실행할 명령이 없음 (`--` 뒤에 명령을 적을 것)');
  return rest.length === 1 ? rest[0]! : rest.map(shq).join(' ');
}

function kst(iso: string): string {
  const t = parseDbUtc(iso);
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') + ' KST';
}

function elapsed(fromIso: string): string {
  const min = Math.max(0, Math.round((Date.now() - parseDbUtc(fromIso)) / 60_000));
  return min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name]?.trim();
  if (!v) throw new CliError(`--${name} 필요`);
  return v;
}

function ownJob(db: Database.Database, ctx: RunTokenRow, idArg: string | undefined): BackgroundJobRow {
  const id = Number(idArg);
  if (!Number.isInteger(id) || id <= 0) throw new CliError('작업 번호(id)가 필요함');
  const job = getBackgroundJob(db, id);
  if (!job || job.threadId !== ctx.threadId) throw new CliError(`#${id}: 이 스레드의 작업이 아님`);
  return job;
}

function describe(job: BackgroundJobRow): string {
  const kind = job.pid !== null ? 'run' : 'watch';
  let state: string = job.status;
  if (job.status === 'pending' && job.pid !== null) {
    state = isSameProcessAlive(job.pid, job.procStartedAt) ? '실행 중' : '프로세스 종료됨(결과 확인 대기)';
  } else if (job.status === 'pending') {
    state = '대기 중';
  }
  const exit = job.jobDir ? readExitCode(job.jobDir) : null;
  return (
    `#${job.id} [${kind}] ${job.description} — ${state}${exit !== null ? ` (exit ${exit})` : ''}, ` +
    `경과 ${elapsed(job.createdAt)}, 만료 ${kst(job.expiresAt)}` +
    (job.jobDir ? `\n    로그: ${path.join(job.jobDir, 'output.log')}` : `\n    조건: ${job.checkCmd}`)
  );
}

function cmdRun(db: Database.Database, ctx: RunTokenRow, args: ParsedArgs): string {
  const description = requireFlag(args.flags, 'desc');
  const doneMessage = requireFlag(args.flags, 'done');
  const ttl = parseTtl(args.flags['ttl']);
  const cwd = path.resolve(args.flags['cwd'] ?? process.cwd());
  if (!fs.existsSync(cwd)) throw new CliError(`cwd 없음: ${cwd}`);
  const command = buildCommand(args.rest);

  const running = getPendingRunJobs(db).filter((j) => j.pid !== null && isSameProcessAlive(j.pid, j.procStartedAt));
  if (running.length >= MAX_CONCURRENT_RUN_JOBS) {
    throw new CliError(
      `동시 실행 한도(${MAX_CONCURRENT_RUN_JOBS}건) 초과 — 먼저 끝나길 기다리거나 cancel 할 것:\n` +
        running.map((j) => `  #${j.id} ${j.description}`).join('\n'),
    );
  }

  const id = insertBackgroundJob(db, {
    threadId: ctx.threadId,
    description,
    checkCmd: 'false', // replaced below once the job dir exists
    cwd,
    doneMessage,
    expiresAt: new Date(Date.now() + ttl.ms),
    runToken: ctx.token,
  });
  const jobDir = path.join(jobsRoot(), String(id));
  try {
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'cmd.sh'), `#!/bin/bash\n${command}\n`, { mode: 0o700 });
    const exitFile = path.join(jobDir, 'exit');
    fs.writeFileSync(
      path.join(jobDir, 'run.sh'),
      [
        '#!/bin/sh',
        `nice -n 10 /bin/bash ${shq(path.join(jobDir, 'cmd.sh'))}`,
        'code=$?',
        `echo "$code" > ${shq(exitFile + '.tmp')} && mv ${shq(exitFile + '.tmp')} ${shq(exitFile)}`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const out = fs.openSync(path.join(jobDir, 'output.log'), 'a');
    const env = { ...process.env };
    delete env['SIMPLECLAW_RUN_TOKEN']; // the job itself must not register more jobs as this thread
    // detached → setsid(): own session + process group, so the engine's exit can't take it down.
    const child = spawn('/bin/sh', [path.join(jobDir, 'run.sh')], {
      cwd,
      detached: true,
      stdio: ['ignore', out, out],
      env,
    });
    fs.closeSync(out);
    if (child.pid === undefined) throw new Error('spawn 실패');
    child.unref();
    setBackgroundJobProcess(db, id, {
      checkCmd: `test -f ${shq(exitFile)}`,
      pid: child.pid,
      procStartedAt: procStartTime(child.pid),
      jobDir,
    });
  } catch (err) {
    markBackgroundJobStatus(db, id, 'failed');
    markBackgroundJobReaped(db, id);
    throw new CliError(`#${id} 시작 실패: ${(err as Error).message}`);
  }
  const job = getBackgroundJob(db, id)!;
  return [
    `✅ job #${id} 등록·시작됨 (PID ${job.pid}, 세션과 분리 실행)`,
    `   로그: ${path.join(jobDir, 'output.log')}`,
    `   만료: ${kst(job.expiresAt)} — 끝나면 성공/실패를 이 스레드에 자동으로 알린다.`,
    ...(ttl.note ? [`   (${ttl.note})`] : []),
  ].join('\n');
}

function cmdWatch(db: Database.Database, ctx: RunTokenRow, args: ParsedArgs): string {
  const description = requireFlag(args.flags, 'desc');
  const checkCmd = requireFlag(args.flags, 'check');
  const doneMessage = requireFlag(args.flags, 'done');
  const ttl = parseTtl(args.flags['ttl']);
  const cwd = path.resolve(args.flags['cwd'] ?? process.cwd());
  if (!fs.existsSync(cwd)) throw new CliError(`cwd 없음: ${cwd}`);
  const id = insertBackgroundJob(db, {
    threadId: ctx.threadId,
    description,
    checkCmd,
    cwd,
    doneMessage,
    expiresAt: new Date(Date.now() + ttl.ms),
    runToken: ctx.token,
  });
  const job = getBackgroundJob(db, id)!;
  return [
    `✅ job #${id} 등록됨 — 60초마다 \`${checkCmd}\` 확인 (cwd ${cwd})`,
    `   만료: ${kst(job.expiresAt)} — 충족되면 이 스레드에 자동으로 알린다.`,
    ...(ttl.note ? [`   (${ttl.note})`] : []),
  ].join('\n');
}

async function cmdCancel(db: Database.Database, ctx: RunTokenRow, args: ParsedArgs): Promise<string> {
  const job = ownJob(db, ctx, args.positional[0]);
  if (job.status !== 'pending') return `#${job.id}는 이미 ${job.status} 상태`;
  if (job.pid !== null && isSameProcessAlive(job.pid, job.procStartedAt)) {
    await killGroup(job.pid, 10_000);
  }
  markBackgroundJobStatus(db, job.id, 'cancelled');
  markBackgroundJobReaped(db, job.id);
  return `🛑 #${job.id} 취소됨${job.pid !== null ? ' (프로세스 그룹 종료)' : ''}`;
}

function cmdExtend(db: Database.Database, ctx: RunTokenRow, args: ParsedArgs): string {
  const job = ownJob(db, ctx, args.positional[0]);
  if (job.status !== 'pending') throw new CliError(`#${job.id}는 이미 ${job.status} 상태라 연장 불가`);
  const ttl = parseTtl(args.positional[1]);
  setBackgroundJobExpiry(db, job.id, new Date(Date.now() + ttl.ms));
  return `⏳ #${job.id} 만료를 ${kst(getBackgroundJob(db, job.id)!.expiresAt)}로 연장${ttl.note ? ` (${ttl.note})` : ''}`;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string }> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return { code: 2, out: `${(err as Error).message}\n\n${USAGE}` };
  }
  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    return { code: 0, out: USAGE };
  }

  const token = env['SIMPLECLAW_RUN_TOKEN'];
  const dbFile =
    env['SIMPLECLAW_DB'] ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'simpleclaw.db');
  if (!token) {
    return { code: 1, out: 'SIMPLECLAW_RUN_TOKEN이 없음 — claw-job은 SimpleClaw가 띄운 엔진 세션 안에서만 쓸 수 있다.' };
  }
  const db = new Database(dbFile, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const ctx = resolveRunToken(db, token);
    if (!ctx) return { code: 1, out: 'SIMPLECLAW_RUN_TOKEN이 만료되었거나 알 수 없음 — 이 턴에서는 등록할 수 없다.' };
    switch (args.command) {
      case 'run':
        return { code: 0, out: cmdRun(db, ctx, args) };
      case 'watch':
        return { code: 0, out: cmdWatch(db, ctx, args) };
      case 'list': {
        const jobs = listBackgroundJobsForThread(db, ctx.threadId, 10);
        return { code: 0, out: jobs.length ? jobs.map(describe).join('\n') : '이 스레드에 등록된 작업 없음' };
      }
      case 'status': {
        const job = ownJob(db, ctx, args.positional[0]);
        const tail = job.jobDir ? tailLog(job.jobDir, 15) : '';
        return { code: 0, out: describe(job) + (tail ? `\n--- 로그 끝부분 ---\n${tail}` : '') };
      }
      case 'extend':
        return { code: 0, out: cmdExtend(db, ctx, args) };
      case 'cancel':
        return { code: 0, out: await cmdCancel(db, ctx, args) };
      default:
        return { code: 2, out: `알 수 없는 명령: ${args.command}\n\n${USAGE}` };
    }
  } catch (err) {
    if (err instanceof CliError) return { code: 1, out: `❌ ${err.message}` };
    return { code: 1, out: `❌ 내부 오류: ${(err as Error).message}` };
  } finally {
    db.close();
  }
}

// Run only when executed directly (tests import the helpers).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then(({ code, out }) => {
    (code === 0 ? process.stdout : process.stderr).write(out + '\n');
    process.exit(code);
  });
}
