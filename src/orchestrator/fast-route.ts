import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { log } from '../log.js';

/**
 * Fast route — 새 요청을 runClaude 전에 repo가 등록한 스크립트로 즉답하는 경로.
 *
 * - route 정의는 repo가 소유: `{repo}/.simpleclaw/routes.json`
 * - 판정은 TypeSafe Jev(System One) Choice 1회 (≈0.6s). 옵션 = route 이름들 + "none"
 * - route 스크립트의 stdout이 곧 Discord 응답 (exit 0 + 비어있지 않을 때만 채택)
 * - 판정 불확실·타임아웃·스크립트 실패는 전부 기존 Claude 경로로 fallback
 */

export const ROUTE_FILE = path.join('.simpleclaw', 'routes.json');
export const NONE_CHOICE = 'none';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 2_000;
const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_ROUTE_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 256 * 1024;

const RouteSchema = z.object({
  /** Jev Choice 옵션 키이자 로그 식별자. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).refine((n) => n !== NONE_CHOICE),
  /** 이 route가 "온전히" 처리하는 요청의 설명 — Jev 판정 기준. 처리 못 하는 경우도 적을 것. */
  when: z.string().min(1),
  /** execFile argv (shell 미경유). 메시지 텍스트는 절대 전달되지 않는다. */
  argv: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

const RouteFileSchema = z.object({
  /** on: 판정대로 즉답 / shadow: 판정만 기록하고 응답은 Claude */
  mode: z.enum(['on', 'shadow']).default('on'),
  minConfidence: z.number().min(0).max(1).default(DEFAULT_MIN_CONFIDENCE),
  routes: z.array(RouteSchema).min(1).max(50),
});

export type FastRoute = z.infer<typeof RouteSchema>;
export type FastRouteFile = z.infer<typeof RouteFileSchema>;

/** 파일이 없으면 null (기능 미사용). 형식 오류도 null + 경고 — 잘못된 설정이 Claude 경로를 막지 않게. */
export async function loadRouteFile(repoPath: string): Promise<FastRouteFile | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(repoPath, ROUTE_FILE), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseRouteFile(raw);
  if (!parsed.ok) log.warn({ repoPath, err: parsed.error }, 'fast-route: invalid routes.json — ignored');
  return parsed.ok ? parsed.file : null;
}

/** @internal exported for testing */
export function parseRouteFile(raw: string): { ok: true; file: FastRouteFile } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const result = RouteFileSchema.safeParse(json);
  if (!result.success) return { ok: false, error: result.error.message.slice(0, 300) };
  const names = result.data.routes.map((r) => r.name);
  if (new Set(names).size !== names.length) return { ok: false, error: 'duplicate route name' };
  return { ok: true, file: result.data };
}

export interface JevChoice {
  choice: string;
  confidence: number;
}

/** @internal exported for testing */
export function buildJevRequest(text: string, routes: FastRoute[]): unknown {
  const criteria: Record<string, string> = {};
  for (const r of routes) criteria[r.name] = r.when;
  criteria[NONE_CHOICE] =
    '위 핸들러 어느 것으로도 추가 정보 없이 온전히 처리할 수 없음 (다른 주제, 핸들러에 없는 장소·목적지·조건 지정, 코드/설정 수정 요청, 설명·의견을 묻는 질문 등)';
  return {
    state: text,
    model: JEV_MODEL,
    questions: {
      route: {
        type: 'choice',
        instructions:
          'Which pre-registered handler can fully answer this user request on its own, with no extra arguments? If none can, choose none.',
        criteria,
      },
    },
  };
}

export async function askJev(
  text: string,
  routes: FastRoute[],
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JevChoice> {
  const res = await fetchImpl(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildJevRequest(text, routes)),
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`jev http ${res.status}`);
  const body = (await res.json()) as { answers?: { route?: { choice?: unknown; confidence?: unknown } } };
  const answer = body.answers?.route;
  if (typeof answer?.choice !== 'string' || typeof answer.confidence !== 'number') {
    throw new Error('jev: malformed response');
  }
  return { choice: answer.choice, confidence: answer.confidence };
}

/** Jev 답을 실행할 route로 변환. "none"·미등록 이름·기준 미달은 null (= Claude). */
export function pickRoute(answer: JevChoice, file: FastRouteFile): FastRoute | null {
  if (answer.choice === NONE_CHOICE) return null;
  if (answer.confidence < file.minConfidence) return null;
  return file.routes.find((r) => r.name === answer.choice) ?? null;
}

export type RouteRunResult =
  | { ok: true; text: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/** route 스크립트 실행. stdout(trim)이 응답. exit≠0·타임아웃·빈 출력은 실패. */
export function runRoute(route: FastRoute, cwd: string): Promise<RouteRunResult> {
  const started = Date.now();
  const [cmd, ...args] = route.argv;
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: route.timeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        // SimpleClaw 비밀(.env)은 넘기지 않는다 — 스크립트는 자기 repo의 설정만 쓴다.
        env: pickEnv(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']),
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started;
        if (err) {
          const detail = String(stderr || err.message).trim().slice(-300);
          resolve({ ok: false, error: detail, durationMs });
          return;
        }
        const text = String(stdout).trim();
        if (!text) {
          resolve({ ok: false, error: 'empty stdout', durationMs });
          return;
        }
        resolve({ ok: true, text, durationMs });
      },
    );
  });
}

function pickEnv(keys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}
