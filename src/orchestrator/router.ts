import { promises as fs } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AppConfig, RepoEntry } from '../config.js';
import { runClaude, ClaudeError } from '../claude.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';
import type { MessageContext, RouteDecision } from './types.js';

const CLASSIFIER_TIMEOUT_MS = 30_000;
const SCRATCH_DIR_NAME = 'router-scratch';

interface ClassifierResultTrivial {
  kind: 'trivial';
  answer: string;
}
interface ClassifierResultRepo {
  kind: 'repo';
  fullName: string;
  instructions?: string;
}
interface ClassifierResultUnclear {
  kind: 'unclear';
  question: string;
}
type ClassifierResult =
  | ClassifierResultTrivial
  | ClassifierResultRepo
  | ClassifierResultUnclear;

/** Ensure the scratch dir exists. Returns absolute path. */
async function ensureScratchDir(dataDir: string): Promise<string> {
  const dir = path.join(dataDir, SCRATCH_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Build the JSON-only Korean classifier prompt. */
function buildClassifierPrompt(text: string, repos: RepoEntry[]): string {
  const repoLines = repos
    .map(
      (r) =>
        `  - fullName: ${r.fullName} | category: ${r.category} | ${r.description}`,
    )
    .join('\n');

  const lines: string[] = [
    '당신은 라우팅 분류기. 아래 사용자 메시지를 다음 셋 중 하나로 분류해 JSON 한 줄만 출력하라.',
    '',
    '1. trivial: 본인 개인 맥락 회상이 불필요한 일반 상식 질문 (단위 환산, 잘 알려진 사실, 짧은 정의 등)',
    '2. repo: 특정 repo에서의 작업·기록·회상이 필요. 다음 중 하나의 fullName을 골라라:',
    repoLines,
    '3. unclear: 어느 repo인지 모호하거나 분류 불가',
    '',
    '출력 형식 — 정확히 한 줄, JSON만 (markdown fence 절대 금지):',
    '{"kind":"trivial","answer":"<짧은 한국어 답변>"}',
    '또는',
    '{"kind":"repo","fullName":"<선택한 repo의 fullName>","instructions":"<원본 요청 그대로 또는 정제>"}',
    '또는',
    '{"kind":"unclear","question":"<사용자에게 다시 물어볼 한국어 질문>"}',
    '',
    '사용자 메시지:',
    '"""',
    text,
    '"""',
    '',
    '---',
    'Reply with EXACTLY one JSON line, no markdown fences, no commentary.',
  ];
  return lines.join('\n');
}

/** Strip markdown fences if claude added them despite instructions. */
function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    // Drop opening fence (with optional language tag) and the closing fence.
    t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/, '');
    t = t.replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

/** Find the first balanced JSON object in a string. Returns null if none found. */
function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseClassifierOutput(raw: string): ClassifierResult | null {
  const cleaned = stripFences(raw);
  const candidate = extractJsonObject(cleaned) ?? cleaned;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === 'trivial') {
    if (typeof obj.answer !== 'string' || obj.answer.length === 0) return null;
    return { kind: 'trivial', answer: obj.answer };
  }
  if (kind === 'repo') {
    if (typeof obj.fullName !== 'string' || obj.fullName.length === 0) return null;
    const instructions =
      typeof obj.instructions === 'string' && obj.instructions.length > 0
        ? obj.instructions
        : undefined;
    return { kind: 'repo', fullName: obj.fullName, instructions };
  }
  if (kind === 'unclear') {
    if (typeof obj.question !== 'string' || obj.question.length === 0) return null;
    return { kind: 'unclear', question: obj.question };
  }
  return null;
}

function findRepoByChannelId(config: AppConfig, channelId: string): RepoEntry | undefined {
  return config.repoChannels.find((r) => r.channelId === channelId);
}

function findRepoByFullName(config: AppConfig, fullName: string): RepoEntry | undefined {
  return config.repoChannels.find((r) => r.fullName === fullName);
}

/**
 * Route an incoming Discord message to a decision.
 *
 * - Bot/own messages → ignore (defense in depth)
 * - Repo-locked channels → unconditional repo-work for that repo
 * - General channel → require mention or thread; classify via claude
 * - DM → classify via claude unconditionally
 */
export async function routeMessage(args: {
  ctx: MessageContext;
  config: AppConfig;
  db: Database.Database;
}): Promise<RouteDecision> {
  const { ctx, config, db } = args;

  // 1. Defense in depth — never respond to bots / our own messages.
  if (ctx.isBot) {
    return { kind: 'ignore', reason: 'author is a bot' };
  }

  // 2. Repo-locked channel → no classification needed.
  const repoLocked = findRepoByChannelId(config, ctx.channelId);
  if (repoLocked) {
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: `repo-locked → ${repoLocked.fullName}`,
      meta: { repo: repoLocked.fullName, mode: 'channel-locked' },
    });
    return { kind: 'repo-work', repo: repoLocked };
  }

  // 2a. claw 자체 유지보수 채널 → claw repo에서 직접 작업.
  if (ctx.channelId === config.clawChannelId) {
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: 'claw-maintenance (channel-locked)',
      meta: { mode: 'channel-locked', target: 'claw' },
    });
    return { kind: 'claw-maintenance' };
  }

  // 2b. wiki ingest 채널 → URL/주제 자동 ingest.
  if (config.wikiChannelId && ctx.channelId === config.wikiChannelId) {
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: 'wiki-ingest (channel-locked)',
      meta: { mode: 'channel-locked', target: 'wiki' },
    });
    return { kind: 'wiki-ingest' };
  }

  const isGeneral = ctx.channelId === config.generalChannelId;
  const isDm = ctx.isDm === true;

  // 3. Neither general nor DM → not for us.
  if (!isGeneral && !isDm) {
    return { kind: 'ignore', reason: 'channel not registered' };
  }

  // 4. General channel + hub repo configured → route directly, no classification needed.
  if (isGeneral && config.hubRepo) {
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: `hub → ${config.hubRepo.fullName}`,
      meta: { repo: config.hubRepo.fullName, mode: 'hub' },
    });
    return { kind: 'repo-work', repo: config.hubRepo };
  }

  // 5. Classify via claude.
  const scratchDir = await ensureScratchDir(config.paths.dataDir);
  const prompt = buildClassifierPrompt(ctx.text, config.repoChannels);

  let raw: string;
  try {
    const result = await runClaude({
      cwd: scratchDir,
      prompt,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
    });
    raw = result.text;
  } catch (err) {
    const e = err instanceof ClaudeError ? err : (err as Error);
    log.error(
      { err: e.message, channel: ctx.channelId },
      'router classifier claude run failed',
    );
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: 'classifier failed (claude run)',
      meta: { error: e.message },
    });
    return { kind: 'ignore', reason: 'classifier failed' };
  }

  const parsed = parseClassifierOutput(raw);
  if (!parsed) {
    log.error({ raw: raw.slice(0, 500) }, 'router classifier produced unparseable output');
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: 'classifier failed (parse)',
      meta: { rawHead: raw.slice(0, 300) },
    });
    return { kind: 'ignore', reason: 'classifier failed' };
  }

  if (parsed.kind === 'trivial') {
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: 'trivial answer',
      meta: { mode: 'trivial', answerLen: parsed.answer.length },
    });
    return { kind: 'trivial', answer: parsed.answer };
  }

  if (parsed.kind === 'unclear') {
    // Treat as a clarifying question to send back to user.
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: 'unclear → ask back',
      meta: { mode: 'unclear' },
    });
    return { kind: 'trivial', answer: parsed.question };
  }

  // parsed.kind === 'repo'
  const repo = findRepoByFullName(config, parsed.fullName);
  if (!repo) {
    log.warn({ fullName: parsed.fullName }, 'classifier picked unknown repo fullName');
    logEvent(db, {
      type: 'router.classify',
      channel: ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: `unknown repo: ${parsed.fullName}`,
      meta: { mode: 'repo', fullName: parsed.fullName },
    });
    return { kind: 'ignore', reason: 'classifier failed' };
  }

  logEvent(db, {
    type: 'router.classify',
    channel: ctx.channelId,
    threadId: ctx.threadId ?? undefined,
    summary: `repo-work → ${repo.fullName}`,
    meta: { mode: 'repo', repo: repo.fullName },
  });
  return { kind: 'repo-work', repo, instructions: parsed.instructions };
}
