import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type Database from 'better-sqlite3';

import { resolveEngineModel } from '../config.js';
import type { AppConfig, RepoEntry } from '../config.js';
import { log } from '../log.js';
import { runClaude, ClaudeError, snapshotSessionFiles, restoreSessionFiles } from '../claude.js';
import { runCodex } from '../codex.js';
import { tmuxRunner, TmuxError } from '../tmux-runner.js';
import { getSession, upsertSession } from '../state/sessions.js';
import { logUsage, buildUsageFooter } from '../state/usage.js';
import { logEvent, searchEvents, type EventSearchResult } from '../state/events.js';
import { emitEvent } from '../dashboard/event-bus.js';
import { routeMessage } from '../orchestrator/router.js';
import { isMemoMessage } from '../orchestrator/memo.js';
import {
  askJev,
  loadRouteFile,
  pickRoute,
  runRoute,
  type FastRoute,
  type FastRouteFile,
  type JevChoice,
} from '../orchestrator/fast-route.js';
import { getPendingBackgroundJobsForThread } from '../state/background-jobs.js';
import { issueRunToken } from '../state/run-tokens.js';
import {
  UNBACKED_PROMISE_WARNING,
  detectsFollowUpPromise,
  formatJobStatus,
  isStatusQuestion,
} from '../orchestrator/job-status.js';
import {
  buildRepoWorkSystemAppend,
  buildSimpleClawMaintenanceSystemAppend,
  buildWikiIngestSystemAppend,
  buildRootSystemAppend,
  SIMPLECLAW_RESTART_MARKER,
  detectPermanentRuleIntent,
  PERMANENT_RULE_NOTICE_INSTRUCTION,
} from '../orchestrator/prompt.js';
import type { MessageContext } from '../messenger/types.js';
import type { MessengerAdapter } from '../messenger/types.js';
import { downloadAttachments, attachmentNote } from '../attachments.js';
import { syncNewTopics } from '../wiki/topic-sync.js';
import { type Artifact } from '../artifact.js';
import {
  setSenderPolicy,
  deleteSenderPolicy,
  getMailThread,
  getMailThreadByMessageId,
  setMailThreadStatus,
} from '../state/mail.js';
import { WorkerIpc } from '../ipc/client.js';
import type { G2WEvent, SerializedMessage } from '../ipc/types.js';

// DiscordPoster kept as a re-export alias for backward compatibility.
export type { MessengerAdapter as DiscordPoster };

// ---------------------------------------------------------------------------
// Button customId helpers (pure functions — exported for testing)
// ---------------------------------------------------------------------------

const IGNORE_SENDER_PREFIX = 'ignore-sender';

export function buildIgnoreSenderButtonId(email: string, account: string): string {
  return `${IGNORE_SENDER_PREFIX}:${email}:${account}`;
}

export function parseIgnoreSenderButtonId(
  customId: string,
): { email: string; account: string } | null {
  if (!customId.startsWith(`${IGNORE_SENDER_PREFIX}:`)) return null;
  const rest = customId.slice(IGNORE_SENDER_PREFIX.length + 1);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return null;
  const email = rest.slice(0, colonIdx);
  const account = rest.slice(colonIdx + 1);
  if (!email || !account) return null;
  return { email, account };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const SAFE_CHUNK_SIZE = 1900; // headroom for the [i/N]\n prefix
const THREAD_NAME_MAX = 90; // Discord limit is 100; leave headroom
const CLAUDE_TIMEOUT_MS = 3_600_000; // 1 hour
/** Absolute path of the claw-job launcher (repo/bin), resolved from dist/adapters/. */
const CLAW_JOB_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'claw-job');

// ---------------------------------------------------------------------------
// Helpers (exported for shape testing)
// ---------------------------------------------------------------------------

/**
 * Build a thread title from a user message:
 * - Strip leading mentions/punctuation
 * - Take the first sentence-ish chunk
 * - Sanitize newlines
 * - Truncate to THREAD_NAME_MAX (Discord limit is 100; headroom kept)
 */
export function makeThreadTitle(content: string): string {
  let s = (content ?? '').trim();
  // Strip leading user/role mentions (`<@123>`, `<@!123>`, `<@&123>`).
  s = s.replace(/^(?:<@[!&]?\d+>\s*)+/, '');
  // Strip leading punctuation.
  s = s.replace(/^[\s\p{P}]+/u, '');
  // Replace any whitespace runs (incl. newlines) with single space.
  s = s.replace(/\s+/g, ' ');
  // Take up to first sentence-end if reasonably short.
  const sentenceMatch = s.match(/^(.+?[.!?。！？])\s/);
  if (sentenceMatch && sentenceMatch[1].length <= THREAD_NAME_MAX) {
    s = sentenceMatch[1];
  }
  s = s.trim();
  if (s.length === 0) return 'untitled';
  if (s.length <= THREAD_NAME_MAX) return s;
  return s.slice(0, THREAD_NAME_MAX - 1).trimEnd() + '…';
}

/**
 * Robust message splitter:
 * - Try to split on paragraph (`\n\n`), then line (`\n`), then sentence (`. `), then char count
 * - Keep code fences balanced across chunks (close ``` on cut, reopen with same language on next)
 * - Each chunk ≤ maxLen
 * - If N > 1, prefix each chunk with `[i/N]\n`
 */
export function splitMessage(text: string, maxLen: number = SAFE_CHUNK_SIZE): string[] {
  if (typeof text !== 'string') {
    throw new Error('splitMessage: text must be a string');
  }
  if (!Number.isInteger(maxLen) || maxLen <= 0) {
    throw new Error('splitMessage: maxLen must be a positive integer');
  }

  const trimmed = text;
  if (trimmed.length === 0) return [''];

  // Reserve room for the "[i/N]\n" prefix in worst case. We don't know N up front,
  // so we conservatively reserve up to "[99/99]\n" → 8 chars.
  const PREFIX_RESERVE = 8;
  const bodyMax = Math.max(1, maxLen - PREFIX_RESERVE);

  // Greedy splitter that prefers breaking on better separators.
  const rawChunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > bodyMax) {
    const window = remaining.slice(0, bodyMax);

    let cutAt = -1;
    // Prefer paragraph break.
    const paraIdx = window.lastIndexOf('\n\n');
    if (paraIdx > bodyMax * 0.4) cutAt = paraIdx + 2;
    if (cutAt === -1) {
      const lineIdx = window.lastIndexOf('\n');
      if (lineIdx > bodyMax * 0.4) cutAt = lineIdx + 1;
    }
    if (cutAt === -1) {
      const sentIdx = window.lastIndexOf('. ');
      if (sentIdx > bodyMax * 0.4) cutAt = sentIdx + 2;
    }
    if (cutAt === -1) cutAt = bodyMax; // hard cut

    rawChunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt);
  }
  if (remaining.length > 0 || rawChunks.length === 0) {
    rawChunks.push(remaining);
  }

  // Re-balance code fences across chunks.
  const balanced: string[] = [];
  let openLang: string | null = null; // language tag of an unclosed fence carried over
  for (const chunkRaw of rawChunks) {
    // Scan the *raw* chunk content for fences, starting from carried-over state.
    const fenceRegex = /```([^\n`]*)\n?/g;
    let m: RegExpExecArray | null;
    let state: string | null = openLang;
    while ((m = fenceRegex.exec(chunkRaw)) !== null) {
      if (state === null) {
        // Opening fence: capture language tag (may be empty).
        state = (m[1] ?? '').trim();
      } else {
        // Closing fence.
        state = null;
      }
    }

    let chunk = chunkRaw;
    // If we entered this chunk inside an open fence, prepend a continuation fence.
    if (openLang !== null) {
      chunk = '```' + openLang + '\n' + chunk;
    }
    // If we exited still inside an open fence, close it for this chunk.
    if (state !== null) {
      chunk = chunk.replace(/\s+$/, '') + '\n```';
    }
    openLang = state;
    balanced.push(chunk);
  }

  // Apply [i/N]\n prefix when more than one chunk.
  const N = balanced.length;
  if (N <= 1) return balanced;
  const out = balanced.map((c, i) => `[${i + 1}/${N}]\n${c}`);

  // Final safety: enforce maxLen by hard-trimming if any chunk overshoots.
  return out.map((c) => (c.length <= maxLen ? c : c.slice(0, maxLen)));
}

/** Truncate a string to `max` characters using a horizontal ellipsis when shortened. */
export function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1).trimEnd() + '…';
}

/**
 * User-facing text for an engine run that died (timeout / non-zero exit).
 *
 * The old raw `claude run failed: claude run exceeded timeout 3600000ms` told the user neither
 * what survived nor how to continue, so the next message was always "다 했어?". The session
 * id is only replaced on success, so the thread's previous session is intact and resumable.
 */
export function formatEngineFailure(
  message: string,
  timeoutMs: number,
  pendingJobs: ReadonlyArray<{ id: number; description: string }> = [],
): string {
  const lines: string[] = [];
  if (/exceeded timeout/.test(message)) {
    lines.push(
      `⏱️ 실행 한도(${Math.round(timeoutMs / 60_000)}분)에 걸려 이번 턴이 중단됐습니다. ` +
        '중단 시점까지 저장·커밋된 결과물은 남아 있고, 세션도 보존돼 있어 "이어서 진행해줘"라고 하면 이어갑니다.',
    );
  } else {
    lines.push(
      `⚠️ 엔진 실행이 실패했습니다: ${truncate(message, 1200)}
세션은 보존돼 있어 같은 스레드에서 다시 요청하면 이어갑니다.`,
    );
  }
  if (pendingJobs.length > 0) {
    lines.push(
      `백그라운드 작업 ${pendingJobs.length}건은 계속 추적 중입니다 (끝나면 자동 알림): ` +
        pendingJobs.map((j) => `#${j.id} ${j.description}`).join(', '),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface DiscordAdapterOpts {
  config: AppConfig;
  db: Database.Database;
  ipc: WorkerIpc;
}

interface TargetChannel {
  channelId: string;
  threadKey: string;
}

interface FastRouteMatch {
  file: FastRouteFile;
  /** null이면 Jev 호출 실패 (error 참고) */
  answer: JevChoice | null;
  /** 실행할 route. null = Claude로 처리 */
  route: FastRoute | null;
  latencyMs: number;
  error?: string;
}

export class DiscordAdapter implements MessengerAdapter {
  readonly platform = 'discord';
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly ipc: WorkerIpc;
  /** Per-thread (or per-channel for DMs) mutex chain. */
  private readonly threadLocks: Map<string, Promise<void>> = new Map();
  /** In-flight engine runs keyed by threadKey — abortable via 🛑 reaction. */
  private readonly activeRuns: Map<string, AbortController> = new Map();
  /** Number of Claude runs currently executing inside runWithMutex. */
  private inFlightCount = 0;
  /** Set when a drain/restart has been requested. */
  private draining = false;

  constructor(opts: DiscordAdapterOpts) {
    if (!opts || !opts.config) throw new Error('DiscordAdapter: config required');
    if (!opts.db) throw new Error('DiscordAdapter: db required');
    if (!opts.ipc) throw new Error('DiscordAdapter: ipc required');
    this.config = opts.config;
    this.db = opts.db;
    this.ipc = opts.ipc;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.ipc.on('event', (msg: G2WEvent) => {
      if (msg.type === 'discord.message') {
        void this.onIpcMessage(msg.ctx, msg.threadKey, msg.msgId, msg.channelId).catch((err) => {
          log.error(
            { err: (err as Error).message, stack: (err as Error).stack },
            'discord onIpcMessage handler crashed',
          );
        });
      } else if (msg.type === 'discord.reaction') {
        void this.onIpcReaction(msg.emoji, msg.msgId, msg.channelId, msg.userId, msg.isOwner, msg.isThread).catch((err) => {
          log.error({ err: (err as Error).message }, 'discord reaction handler crashed');
        });
      } else if (msg.type === 'config.repo.added') {
        if (!this.config.repoChannels.some((r) => r.channelId === msg.repo.channelId)) {
          this.config.repoChannels.push(msg.repo);
          log.info({ fullName: msg.repo.fullName, channelId: msg.repo.channelId }, 'repo bound at runtime');
        }
      } else if (msg.type === 'discord.button') {
        void this.onIpcButton(msg.customId, msg.channelId, msg.msgId, msg.interactionId, msg.token).catch((err) => {
          log.error({ err: (err as Error).message }, 'discord button interaction handler crashed');
        });
      }
    });
    this.ipc.ready();
  }

  async stop(): Promise<void> {
    // ipc cleanup done by worker.ts
  }

  // -------------------------------------------------------------------------
  // Button interaction handling
  // -------------------------------------------------------------------------

  private async onIpcButton(
    customId: string,
    _channelId: string,
    _msgId: string,
    interactionId: string,
    token: string,
  ): Promise<void> {
    // ignore-sender button
    const ignoreParsed = parseIgnoreSenderButtonId(customId);
    if (ignoreParsed) {
      const { email, account } = ignoreParsed;
      setSenderPolicy(this.db, { email, account, policy: 'ignore', reason: 'Discord 버튼으로 무시 설정' });
      log.info({ email, account }, 'sender ignored via button');
      logEvent(this.db, {
        type: 'importance.classify',
        summary: `button ignore: ${email}`,
        meta: { mode: 'button', verdict: 'ignore', from: email, account },
      });
      await this.ipc.interactionReply(interactionId, token, `앞으로 **${email}** 발신자의 메일은 무시합니다.`, true);
      return;
    }

  }

  // -------------------------------------------------------------------------
  // Reaction handling (✅ / ❌ on mail alert threads or general threads)
  // -------------------------------------------------------------------------

  private async onIpcReaction(
    emoji: string,
    msgId: string,
    channelId: string,
    _userId: string,
    isOwner: boolean,
    isThread: boolean,
  ): Promise<void> {
    if (!isOwner) return;

    // 🛑: abort the in-flight engine run for this thread. The cancelled run's own
    // catch block posts the confirmation, so this only replies when nothing is running.
    if (emoji === '🛑') {
      await this.handleCancelReaction(channelId, isThread);
      return;
    }

    if (emoji !== '✅' && emoji !== '❌') return;

    // Find the mail thread: by starter message ID, or by thread channel ID.
    const mailThread =
      getMailThreadByMessageId(this.db, msgId) ??
      getMailThread(this.db, channelId);

    if (mailThread) {
      setMailThreadStatus(this.db, mailThread.discordThreadId, 'resolved');
      log.info({ threadId: mailThread.discordThreadId, emoji }, 'mail thread resolved via reaction');
      logEvent(this.db, {
        type: 'mail.resolved',
        threadId: mailThread.discordThreadId,
        summary: `${emoji} ${mailThread.subject}`,
        meta: { emoji, discordMessageId: mailThread.discordMessageId },
      });

      if (emoji === '❌') {
        // Delete the thread (and all messages within it).
        try {
          await this.ipc.discordDeleteThread(mailThread.discordThreadId);
        } catch (err) {
          log.error(
            { err: (err as Error).message, threadId: mailThread.discordThreadId },
            'failed to delete mail alert thread',
          );
        }

        // Delete the parent channel message (starter message).
        if (mailThread.discordMessageId) {
          try {
            this.ipc.discordDeleteMessage(this.config.mailAlertChannelId, mailThread.discordMessageId);
          } catch (err) {
            log.error(
              { err: (err as Error).message, messageId: mailThread.discordMessageId },
              'failed to delete mail alert message',
            );
          }
        }
      } else {
        // ✅: keep the thread, just close (archive) it.
        try {
          await this.ipc.discordArchiveThread(mailThread.discordThreadId);
        } catch (err) {
          log.error(
            { err: (err as Error).message, threadId: mailThread.discordThreadId },
            'failed to archive mail alert thread',
          );
        }
      }
      return;
    }

    // General (non-mail) thread: ✅ archives (closes), ❌ deletes the thread channel.
    // 스레드가 아닌 일반 채널의 메시지에 달린 리액션은 무시 — 채널 자체가 삭제/아카이브되는 사고 방지.
    if (!isThread) {
      log.info({ channelId, msgId, emoji }, 'reaction on non-thread channel ignored');
      return;
    }

    if (emoji === '✅') {
      try {
        await this.ipc.discordArchiveThread(channelId);
        log.info({ threadId: channelId }, 'general thread archived via ✅ reaction');
        logEvent(this.db, {
          type: 'thread.archived',
          threadId: channelId,
          summary: '✅ 리액션으로 스레드 닫기',
          meta: { channelId },
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, channelId },
          'failed to archive general thread',
        );
      }
      return;
    }

    try {
      await this.ipc.discordDeleteThread(channelId);
      log.info({ threadId: channelId }, 'general thread deleted via ❌ reaction');
      logEvent(this.db, {
        type: 'thread.deleted',
        threadId: channelId,
        summary: '❌ 리액션으로 스레드 삭제',
        meta: { channelId },
      });
    } catch (err) {
      log.error(
        { err: (err as Error).message, channelId },
        'failed to delete general thread',
      );
    }
  }

  private async handleCancelReaction(channelId: string, isThread: boolean): Promise<void> {
    const controller = this.activeRuns.get(channelId);
    if (!controller || controller.signal.aborted) {
      // 일반 채널(스레드 아님)에는 안내를 남기지 않는다 — 무관한 🛑 리액션에 대한 노이즈 방지.
      if (!isThread) {
        log.info({ channelId }, 'cancel: 🛑 on non-thread channel with no active run — ignored');
        return;
      }
      try {
        await this.safeSend(channelId, '취소할 실행 중인 작업이 없습니다.');
      } catch (err) {
        log.error({ err: (err as Error).message, channelId }, 'cancel: reply failed');
      }
      return;
    }

    log.info({ threadId: channelId }, 'run cancel requested via 🛑 reaction');
    controller.abort();
    // tmux 엔진은 AbortSignal이 폴링만 멈추므로 pane에 Escape도 전송 (세션 없으면 no-op).
    void tmuxRunner.interrupt(channelId).catch((err: Error) =>
      log.warn({ err: err.message, channelId }, 'cancel: tmux interrupt failed'),
    );
  }

  /**
   * Env for an engine run: a fresh claw-job token bound to this thread, plus where the CLI and
   * DB live. Failing to issue a token must not block the run — the session just can't register
   * follow-ups (and claw-job says so loudly), which is the pre-claw-job behaviour.
   */
  private engineEnv(threadKey: string, repo: string, authorIsOwner: boolean): Record<string, string> {
    try {
      return {
        SIMPLECLAW_RUN_TOKEN: issueRunToken(this.db, { threadId: threadKey, repo, authorIsOwner }),
        SIMPLECLAW_JOB_CLI: CLAW_JOB_CLI,
        SIMPLECLAW_DB: this.config.paths.dbFile,
      };
    } catch (err) {
      log.warn({ err: (err as Error).message, threadId: threadKey }, 'engineEnv: run token issue failed');
      return {};
    }
  }

  /**
   * The complete environment for a sandboxed session — built up, not filtered down.
   *
   * `process.env` is not a safe starting point here: dotenv loads the whole `.env` into it, so
   * inheriting would pass GH_TOKEN, DISCORD_BOT_TOKEN and every Gmail refresh token straight to a
   * session the Seatbelt profile exists to keep away from exactly those secrets.
   *
   * No SIMPLECLAW_RUN_TOKEN / SIMPLECLAW_JOB_CLI either: claw-job is deliberately unavailable.
   */
  private sandboxEnv(repo: RepoEntry): Record<string, string> {
    const sandbox = repo.sandbox!;
    const env: Record<string, string> = {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: sandbox.home,
      LANG: process.env['LANG'] ?? 'en_US.UTF-8',
      // The engine authenticates with this token rather than a keychain entry, which is what lets
      // a session with its own HOME work at all.
      CLAUDE_CODE_OAUTH_TOKEN: this.config.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    // `${VAR}` expands from our own environment, so a session's credentials stay in .env instead
    // of being copied into simpleclaw.config.json as a second plaintext location.
    for (const [key, value] of Object.entries(sandbox.env ?? {})) {
      env[key] = value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '');
    }
    const tmp = process.env['TMPDIR'];
    if (tmp) env['TMPDIR'] = tmp;
    return env;
  }

  /**
   * Append a visible warning when a reply promises a follow-up but nothing is registered to
   * deliver it — the promise is otherwise indistinguishable from a real one until the user asks.
   */
  private guardPromise(text: string, threadKey: string, channelLabel: string): string {
    if (!detectsFollowUpPromise(text)) return text;
    if (getPendingBackgroundJobsForThread(this.db, threadKey).length > 0) return text;
    logEvent(this.db, {
      type: 'promise.unbacked',
      channel: channelLabel,
      threadId: threadKey,
      summary: text.slice(-300),
    });
    return text + UNBACKED_PROMISE_WARNING;
  }

  /** Post the cancellation notice + log events after an aborted engine run. */
  private async notifyCancelled(
    channelLabel: string,
    threadKey: string,
    channelId: string,
    flow: string,
  ): Promise<void> {
    log.info({ channel: channelLabel, threadId: threadKey, flow }, 'engine run cancelled');
    logEvent(this.db, {
      type: 'claude.cancelled',
      channel: channelLabel,
      threadId: threadKey,
      summary: '🛑 리액션으로 실행 취소됨',
      meta: { flow },
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'claude.cancelled',
      channel: channelLabel,
      threadId: threadKey,
      summary: '🛑 리액션으로 실행 취소됨',
    });
    try {
      await this.safeSend(
        channelId,
        '⏹ 작업을 취소했습니다. 취소 시점까지 이미 수행된 변경사항(파일 수정·커밋 등)은 롤백되지 않습니다.',
      );
    } catch (err) {
      log.error({ err: (err as Error).message, threadId: threadKey }, 'cancel notice send failed');
    }
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private async onIpcMessage(
    ctx: MessageContext,
    threadKey: string,
    msgId: string,
    channelId: string,
  ): Promise<void> {
    // Drain in progress — Gateway is buffering these, so just return.
    if (this.draining) return;

    // Log inbound.
    logEvent(this.db, {
      type: 'discord.message.in',
      channel: ctx.channelName ?? ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: ctx.text.slice(0, 500),
      meta: {
        authorId: ctx.authorId,
        isMention: ctx.isMention,
        isDm: ctx.isDm === true,
      },
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'discord.message.in',
      channel: ctx.channelName ?? ctx.channelId,
      threadId: ctx.threadId ?? undefined,
      summary: ctx.text.slice(0, 500),
    });

    // 기록 전용 마커(📝 등)로 시작하면 여기서 끝 — 스레드도 만들지 않고 엔진도 돌리지 않는다.
    // 라우팅 파이프라인보다 먼저 검사하는 이유: repo 바인딩 채널은 라우터에 도달하는 순간
    // 무조건 repo-work가 되므로, 그 앞에서 잘라내야 "기록일 뿐"이 지켜진다.
    if (isMemoMessage(ctx.text)) {
      logEvent(this.db, {
        type: 'discord.message.memo',
        channel: ctx.channelName ?? ctx.channelId,
        threadId: ctx.threadId ?? undefined,
        summary: ctx.text.slice(0, 500),
        meta: { authorId: ctx.authorId },
      });
      log.info(
        { channel: ctx.channelName ?? ctx.channelId, msgId },
        'memo marker — skipped (no thread, no engine run)',
      );
      // 무반응과 구분되도록 원본 메시지에 리액션만 남긴다 (스레드·메시지 생성 없음).
      this.ipc.discordReact(channelId, msgId, '🗒️');
      return;
    }

    // "다 했어?" in a thread with registered background jobs: answer from the job table directly.
    // No engine resume — the jobs are the ground truth, and a resume costs a full turn.
    if (ctx.threadId && isStatusQuestion(ctx.text)) {
      const jobs = getPendingBackgroundJobsForThread(this.db, ctx.threadId);
      if (jobs.length > 0) {
        const answer = formatJobStatus(jobs);
        await this.safeSend(channelId, answer).catch((err: Error) =>
          log.error({ err: err.message }, 'job status reply failed'),
        );
        logEvent(this.db, {
          type: 'discord.message.out',
          channel: ctx.channelName ?? ctx.channelId,
          threadId: ctx.threadId,
          summary: answer.slice(0, 500),
          meta: { mode: 'job-status' },
        });
        return;
      }
    }

    // /search shortcut — intercept before routing pipeline.
    if (ctx.text.startsWith('/search')) {
      const query = ctx.text.slice('/search'.length).trim();
      await this.handleSearchCommand(query, ctx, channelId);
      return;
    }

    // 무시 해제 {email} — remove sender from ignore list.
    if (ctx.text.startsWith('무시 해제 ')) {
      const email = ctx.text.slice('무시 해제 '.length).trim();
      if (email) {
        deleteSenderPolicy(this.db, email);
        await this.ipc.discordSend(channelId, `✅ **${email}** 발신자의 무시 설정을 해제했습니다. 앞으로 이 발신자의 메일은 다시 알림이 옵니다.`);
      }
      return;
    }

    // !기억 — removed along with the memory pipeline. Reply instead of falling through to a
    // repo session, which would silently treat the command as a work request.
    if (ctx.text.startsWith('!기억')) {
      await this.safeSend(
        channelId,
        '`!기억`은 제거되었습니다 (메모리 파이프라인 폐지). 영구적으로 남길 내용은 skill 파일이나 repo의 CLAUDE.md에 저장해주세요.',
      );
      return;
    }

    let decision;
    try {
      decision = await routeMessage({ ctx, config: this.config, db: this.db });
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'routeDiscord crashed',
      );
      return;
    }

    switch (decision.kind) {
      case 'ignore':
        log.debug(
          { channel: ctx.channelName ?? ctx.channelId, reason: decision.reason },
          'discord message ignored',
        );
        return;
      case 'trivial': {
        try {
          await this.safeSend(channelId, truncate(decision.answer, DISCORD_MESSAGE_HARD_LIMIT));
        } catch (err) {
          log.error({ err: (err as Error).message }, 'failed to send trivial reply');
        }
        logEvent(this.db, {
          type: 'discord.message.out',
          channel: ctx.channelName ?? ctx.channelId,
          threadId: ctx.threadId ?? undefined,
          summary: decision.answer.slice(0, 500),
          meta: { mode: 'trivial' },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'discord.message.out',
          channel: ctx.channelName ?? ctx.channelId,
          threadId: ctx.threadId ?? undefined,
          summary: decision.answer.slice(0, 500),
        });
        return;
      }
      case 'repo-work':
        await this.handleRepoWork(ctx, decision.repo, decision.instructions, threadKey, msgId, channelId);
        return;
      case 'simpleclaw-maintenance':
        await this.handleSimpleClawMaintenance(ctx, threadKey, msgId, channelId);
        return;
      case 'wiki-ingest':
        await this.handleWikiIngest(ctx, threadKey, msgId, channelId);
        return;
      case 'root':
        await this.handleRoot(ctx, threadKey, msgId, channelId);
        return;
      default: {
        // Exhaustiveness guard.
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Repo-work flow
  // -------------------------------------------------------------------------

  private async handleRepoWork(
    ctx: MessageContext,
    repo: RepoEntry,
    _instructions: string | undefined,
    threadKey: string,
    msgId: string,
    channelId: string,
  ): Promise<void> {
    const isDm = ctx.isDm;
    const isThread = ctx.threadId !== null;

    // 0. Fast route 판정은 새 top-level 메시지에서만, 스레드 생성과 병렬로 시작.
    //    스레드 안 후속 메시지는 판정 없이 항상 Claude (세션이 없으면 아래 threadContext로 이어받음).
    const fastMatch = !isDm && !isThread ? this.matchFastRoute(ctx, repo) : null;

    // 1. Determine target channel/thread + session key.
    let target: TargetChannel;
    try {
      if (isDm || isThread) {
        // channelId is already the thread or DM channel
        target = { channelId, threadKey };
      } else {
        // Top-level message in a repo or general channel: open a thread.
        const title = makeThreadTitle(ctx.text || repo.fullName);
        const { threadId: newThreadId } = await this.ipc.discordCreateThread(
          channelId,
          msgId,
          truncate(title, THREAD_NAME_MAX),
        );
        target = { channelId: newThreadId, threadKey: newThreadId };
        threadKey = newThreadId;
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'failed to resolve discord target / open thread',
      );
      return;
    }

    // 2. If this is a thread with no existing session (e.g. reply to a mail alert thread),
    //    fetch prior thread content so Claude has context.
    const existingSession = getSession(this.db, threadKey);
    const threadContext =
      isThread && !existingSession ? await this.fetchThreadContext(channelId, msgId) : undefined;

    // 3. Per-thread mutex.
    await this.runWithMutex(threadKey, async () => {
      if (fastMatch && (await this.tryFastRoute(fastMatch, ctx, repo, target))) return;
      await this.runRepoWorkInThread(ctx, repo, target, threadKey, threadContext);
    });
  }

  // -------------------------------------------------------------------------
  // Fast route — repo가 등록한 스크립트로 Claude 없이 즉답 (src/orchestrator/fast-route.ts)
  // -------------------------------------------------------------------------

  private async matchFastRoute(ctx: MessageContext, repo: RepoEntry): Promise<FastRouteMatch | null> {
    const apiKey = this.config.env.TYPESAFE_API_KEY;
    // 스크립트 실행이므로 owner 전용. 첨부·(btw)·빈 메시지는 Claude가 봐야 하는 요청.
    if (!apiKey || ctx.authorId !== this.config.env.DISCORD_OWNER_USER_ID) return null;
    const text = ctx.text.trim();
    if (!text || text.startsWith('(btw)') || (ctx.attachments?.length ?? 0) > 0) return null;

    const file = await loadRouteFile(repo.localPath);
    if (!file) return null;

    const started = Date.now();
    try {
      const answer = await askJev(text, file.routes, apiKey);
      return { file, answer, route: pickRoute(answer, file), latencyMs: Date.now() - started };
    } catch (err) {
      return { file, answer: null, route: null, latencyMs: Date.now() - started, error: (err as Error).message };
    }
  }

  /** true면 응답 완료. false면 호출자가 Claude 경로로 계속 진행. */
  private async tryFastRoute(
    pending: Promise<FastRouteMatch | null>,
    ctx: MessageContext,
    repo: RepoEntry,
    target: TargetChannel,
  ): Promise<boolean> {
    const match = await pending;
    if (!match) return false;

    const channelLabel = ctx.channelName ?? ctx.channelId;
    const apply = match.route !== null && match.file.mode === 'on';
    logEvent(this.db, {
      type: 'fastroute.match',
      channel: channelLabel,
      threadId: target.threadKey,
      summary: match.error
        ? `jev error: ${match.error}`
        : `${match.answer?.choice} (${match.answer?.confidence}) → ${apply ? match.route?.name : 'claude'} ${match.latencyMs}ms`,
      meta: {
        repo: repo.fullName,
        mode: match.file.mode,
        choice: match.answer?.choice ?? null,
        confidence: match.answer?.confidence ?? null,
        route: match.route?.name ?? null,
        applied: apply,
        latencyMs: match.latencyMs,
        error: match.error ?? null,
      },
    });
    if (!apply || !match.route) return false;

    const route = match.route;
    const stopTyping = this.startTyping(target.channelId);
    let result;
    try {
      result = await runRoute(route, repo.localPath);
    } finally {
      stopTyping();
    }
    if (!result.ok) {
      log.warn({ route: route.name, repo: repo.fullName, err: result.error }, 'fast route failed — falling back to claude');
      logEvent(this.db, {
        type: 'fastroute.error',
        channel: channelLabel,
        threadId: target.threadKey,
        summary: `${route.name}: ${result.error}`.slice(0, 500),
        meta: { repo: repo.fullName, route: route.name, durationMs: result.durationMs },
      });
      return false;
    }

    const footer = `-# ⚡ fast route \`${route.name}\` · 판정 ${(match.latencyMs / 1000).toFixed(1)}s + 실행 ${(result.durationMs / 1000).toFixed(1)}s — 이어서 말하면 Claude가 받아요`;
    const chunks = splitMessage(result.text, SAFE_CHUNK_SIZE);
    chunks[chunks.length - 1] += '\n' + footer;
    for (const chunk of chunks) {
      try {
        await this.safeSend(target.channelId, chunk);
      } catch (err) {
        log.error({ err: (err as Error).message, route: route.name }, 'fast route: failed to send chunk');
        break;
      }
    }
    const summary = result.text.slice(0, 500);
    logEvent(this.db, {
      type: 'discord.message.out',
      channel: channelLabel,
      threadId: target.threadKey,
      summary,
      meta: { mode: 'fast-route', route: route.name, matchMs: match.latencyMs, runMs: result.durationMs },
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'discord.message.out',
      channel: channelLabel,
      threadId: target.threadKey,
      summary,
    });
    return true;
  }

  private async runRepoWorkInThread(
    ctx: MessageContext,
    repo: RepoEntry,
    target: TargetChannel,
    threadKey: string,
    threadContext?: string,
  ): Promise<void> {
    const channelLabel = ctx.channelName ?? ctx.channelId;
    const isBtw = ctx.text.trimStart().startsWith('(btw)');
    // A sandboxed repo always runs on claude, so its alias applies whatever `engine` says.
    // undefined → we pass no --model and the CLI's own default serves the turn.
    const channelModel = repo.sandbox ? repo.model : resolveEngineModel(repo);

    // Look up existing claude session.
    const sessionRow = getSession(this.db, threadKey);
    const resumeId = sessionRow?.claudeSessionId;

    // Typing indicator.
    const stopTyping = this.startTyping(target.channelId);
    const controller = new AbortController();
    this.activeRuns.set(threadKey, controller);

    try {
      const savedPaths = await downloadAttachments(ctx.attachments ?? []);

      const baseText = ctx.text + attachmentNote(savedPaths);
      const userMessage = threadContext ? `${threadContext}\n\n${baseText}` : baseText;

      const baseSystemAppend = buildRepoWorkSystemAppend({
        userMessage,
        repo,
        isContinuation: Boolean(resumeId),
        authorIsOwner: ctx.authorId === this.config.env.DISCORD_OWNER_USER_ID,
      });
      const systemAppend = detectPermanentRuleIntent(ctx.text)
        ? `${baseSystemAppend}\n- ${PERMANENT_RULE_NOTICE_INSTRUCTION}`
        : baseSystemAppend;

      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `repo=${repo.fullName} resume=${Boolean(resumeId)}`,
        meta: { repo: repo.fullName, resume: Boolean(resumeId), model: channelModel },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `repo=${repo.fullName} resume=${Boolean(resumeId)}`,
      });

      // For (btw) messages: snapshot session files before running so we can roll back after.
      // A sandboxed session writes its transcripts under its own HOME, not ours.
      const btwSnapshot = isBtw
        ? await snapshotSessionFiles(repo.localPath, repo.sandbox?.home)
        : undefined;

      let result;
      try {
        if (repo.engine === 'tmux') {
          const tmuxResult = await tmuxRunner.run({
            cwd: repo.localPath,
            prompt: userMessage,
            systemAppend,
            sessionKey: threadKey,
            signal: controller.signal,
            timeoutMs: CLAUDE_TIMEOUT_MS,
          });
          result = {
            text: tmuxResult.text,
            sessionId: tmuxResult.sessionKey,
            durationMs: tmuxResult.durationMs,
            exitCode: tmuxResult.exitCode,
            artifacts: tmuxResult.artifacts,
            contextWindowUsed: 0,
            contextWindowMax: 0,
            costUsd: 0,
            model: undefined,
          };
        } else if (repo.sandbox) {
          // codex has no sandbox plumbing — a sandboxed repo always runs on claude.
          result = await runClaude({
            cwd: repo.localPath,
            prompt: userMessage,
            systemAppend,
            resume: resumeId,
            signal: controller.signal,
            timeoutMs: CLAUDE_TIMEOUT_MS,
            envReplace: this.sandboxEnv(repo),
            sandboxProfile: repo.sandbox.profile,
            model: channelModel,
          });
        } else {
          const runner = repo.engine === 'codex' ? runCodex : runClaude;
          result = await runner({
            cwd: repo.localPath,
            prompt: userMessage,
            systemAppend,
            resume: resumeId,
            signal: controller.signal,
            timeoutMs: CLAUDE_TIMEOUT_MS,
            env: this.engineEnv(threadKey, repo.fullName, ctx.authorId === this.config.env.DISCORD_OWNER_USER_ID),
            model: channelModel,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          await this.notifyCancelled(channelLabel, threadKey, target.channelId, 'repo-work');
          return;
        }
        const e = err instanceof ClaudeError || err instanceof TmuxError ? err : (err as Error);
        log.error(
          { err: e.message, channel: channelLabel, threadId: threadKey, repo: repo.fullName },
          'engine run failed in repo-work',
        );
        logEvent(this.db, {
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
          meta: { repo: repo.fullName },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
        });
        try {
          await this.safeSend(
            target.channelId,
            formatEngineFailure(e.message, CLAUDE_TIMEOUT_MS, getPendingBackgroundJobsForThread(this.db, threadKey)),
          );
        } catch (sendErr) {
          log.error(
            { err: (sendErr as Error).message },
            'failed to post claude error message',
          );
        }
        return;
      }

      // Log usage and build footer.
      logUsage(this.db, {
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
      });
      const usageFooter = buildUsageFooter({
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
        model: result.model,
        modelIsDefault: !channelModel,
        rateLimits: result.rateLimits,
      });

      const chunks = splitMessage(this.guardPromise(result.text, threadKey, channelLabel), SAFE_CHUNK_SIZE);
      if (chunks.length > 0) chunks[chunks.length - 1] += '\n' + usageFooter;
      for (let i = 0; i < chunks.length; i++) {
        try {
          await this.safeSend(target.channelId, chunks[i]);
        } catch (err) {
          log.error(
            { err: (err as Error).message, channel: channelLabel, threadId: threadKey },
            'failed to send response chunk',
          );
          break;
        }
      }

      // Send artifact attachments/links after text.
      await this.sendArtifacts(target.channelId, result.artifacts);

      // (btw) mode: restore session files to pre-run state so this exchange is ephemeral.
      if (isBtw && btwSnapshot) {
        await restoreSessionFiles(repo.localPath, btwSnapshot, repo.sandbox?.home).catch((err: Error) =>
          log.warn({ err: err.message, threadId: threadKey }, 'btw: session restore failed'),
        );
      }

      // Persist session — skip for (btw) so the context pointer stays at the pre-btw state.
      if (!isBtw) {
        try {
          upsertSession(this.db, {
            threadId: threadKey,
            claudeSessionId: result.sessionId,
            repo: repo.fullName,
            cwd: repo.localPath,
          });
        } catch (err) {
          log.error(
            { err: (err as Error).message, threadId: threadKey },
            'failed to upsert session',
          );
        }
      }

      // Result + outbound logs.
      logEvent(this.db, {
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
        meta: { duration_seconds: result.durationMs / 1000, repo: repo.fullName },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
      });

      logEvent(this.db, {
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: result.text.slice(0, 500),
        meta: { chunks: chunks.length },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: result.text.slice(0, 500),
      });
    } finally {
      this.activeRuns.delete(threadKey);
      stopTyping();
    }
  }

  // -------------------------------------------------------------------------
  // Claw self-maintenance flow
  // -------------------------------------------------------------------------

  private async handleSimpleClawMaintenance(
    ctx: MessageContext,
    threadKey: string,
    msgId: string,
    channelId: string,
  ): Promise<void> {
    const isThread = ctx.threadId !== null;

    let target: TargetChannel;
    try {
      if (isThread) {
        target = { channelId, threadKey };
      } else {
        const title = makeThreadTitle(ctx.text || 'SimpleClaw 유지보수');
        const { threadId: newThreadId } = await this.ipc.discordCreateThread(
          channelId,
          msgId,
          truncate(title, THREAD_NAME_MAX),
        );
        target = { channelId: newThreadId, threadKey: newThreadId };
        threadKey = newThreadId;
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'failed to resolve discord target / open thread (simpleclaw-maintenance)',
      );
      return;
    }

    const existingSession = getSession(this.db, threadKey);
    const threadContext =
      isThread && !existingSession ? await this.fetchThreadContext(channelId, msgId) : undefined;

    await this.runWithMutex(threadKey, () =>
      this.runSimpleClawMaintenanceInThread(ctx, target, threadKey, threadContext),
    );
  }

  private async runSimpleClawMaintenanceInThread(
    ctx: MessageContext,
    target: TargetChannel,
    threadKey: string,
    threadContext?: string,
  ): Promise<void> {
    const channelLabel = ctx.channelName ?? ctx.channelId;
    const cwd = this.config.simpleclawRepoPath;
    const channelModel = this.config.channelModels.simpleclaw;

    const sessionRow = getSession(this.db, threadKey);
    const resumeId = sessionRow?.claudeSessionId;

    const stopTyping = this.startTyping(target.channelId);
    const controller = new AbortController();
    this.activeRuns.set(threadKey, controller);

    try {
      const savedPaths = await downloadAttachments(ctx.attachments ?? []);

      const baseText = ctx.text + attachmentNote(savedPaths);
      const userMessage = threadContext ? `${threadContext}\n\n${baseText}` : baseText;

      const baseSystemAppend = buildSimpleClawMaintenanceSystemAppend({
        isContinuation: Boolean(resumeId),
        authorIsOwner: ctx.authorId === this.config.env.DISCORD_OWNER_USER_ID,
      });
      const systemAppend = detectPermanentRuleIntent(ctx.text)
        ? `${baseSystemAppend}\n- ${PERMANENT_RULE_NOTICE_INSTRUCTION}`
        : baseSystemAppend;

      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `simpleclaw-maintenance resume=${Boolean(resumeId)}`,
        meta: { target: 'simpleclaw', resume: Boolean(resumeId), model: channelModel },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `simpleclaw-maintenance resume=${Boolean(resumeId)}`,
      });

      let result;
      try {
        result = await runClaude({
          cwd,
          prompt: userMessage,
          systemAppend,
          resume: resumeId,
          signal: controller.signal,
          timeoutMs: CLAUDE_TIMEOUT_MS,
          env: this.engineEnv(threadKey, 'simpleclaw', ctx.authorId === this.config.env.DISCORD_OWNER_USER_ID),
          model: channelModel,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          await this.notifyCancelled(channelLabel, threadKey, target.channelId, 'simpleclaw-maintenance');
          return;
        }
        const e = err instanceof ClaudeError ? err : (err as Error);
        log.error(
          { err: e.message, channel: channelLabel, threadId: threadKey },
          'claude run failed in simpleclaw-maintenance',
        );
        logEvent(this.db, {
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
          meta: { target: 'simpleclaw' },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
        });
        try {
          await this.safeSend(
            target.channelId,
            formatEngineFailure(e.message, CLAUDE_TIMEOUT_MS, getPendingBackgroundJobsForThread(this.db, threadKey)),
          );
        } catch (sendErr) {
          log.error(
            { err: (sendErr as Error).message },
            'failed to post claude error message (simpleclaw-maintenance)',
          );
        }
        return;
      }

      // Detect & strip restart marker before posting.
      const { text: visibleText, restart: markerRestart } = extractRestartMarker(result.text);

      // Fallback: if the marker was omitted, check git diff and force restart if src changed.
      let restart = markerRestart;
      if (!restart) {
        const srcModified = await checkSrcModifiedInLastCommit(cwd);
        if (srcModified) {
          log.warn(
            { channel: channelLabel, threadId: threadKey },
            'restart marker absent but src files modified in last commit — forcing restart',
          );
          restart = true;
        }
      }

      // Log usage and build footer.
      logUsage(this.db, {
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
      });
      const clawUsageFooter = buildUsageFooter({
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
        model: result.model,
        modelIsDefault: !channelModel,
        rateLimits: result.rateLimits,
      });

      const chunks = splitMessage(this.guardPromise(visibleText, threadKey, channelLabel), SAFE_CHUNK_SIZE);
      if (chunks.length > 0) chunks[chunks.length - 1] += '\n' + clawUsageFooter;
      for (let i = 0; i < chunks.length; i++) {
        try {
          await this.safeSend(target.channelId, chunks[i]);
        } catch (err) {
          log.error(
            { err: (err as Error).message, channel: channelLabel, threadId: threadKey },
            'failed to send response chunk (simpleclaw-maintenance)',
          );
          break;
        }
      }

      // Send artifact attachments/links after text.
      await this.sendArtifacts(target.channelId, result.artifacts);

      try {
        upsertSession(this.db, {
          threadId: threadKey,
          claudeSessionId: result.sessionId,
          repo: 'greatSumini/simpleclaw',
          cwd,
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: threadKey },
          'failed to upsert session (simpleclaw-maintenance)',
        );
      }

      logEvent(this.db, {
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${visibleText.length}chars${restart ? ' [restart]' : ''}`,
        meta: {
          duration_seconds: result.durationMs / 1000,
          target: 'simpleclaw',
          restart,
        },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${visibleText.length}chars${restart ? ' [restart]' : ''}`,
      });

      logEvent(this.db, {
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: visibleText.slice(0, 500),
        meta: { chunks: chunks.length, target: 'simpleclaw', restart },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: visibleText.slice(0, 500),
      });

      // Schedule graceful restart after Discord post + session persist.
      if (restart) {
        this.scheduleGracefulRestart(channelLabel, threadKey);
      }
    } finally {
      this.activeRuns.delete(threadKey);
      stopTyping();
    }
  }

  // -------------------------------------------------------------------------
  // Wiki ingest flow
  // -------------------------------------------------------------------------

  private async handleWikiIngest(
    ctx: MessageContext,
    threadKey: string,
    msgId: string,
    channelId: string,
  ): Promise<void> {
    const isThread = ctx.threadId !== null;
    const isUrl = /^https?:\/\/\S+$/.test(ctx.text.trim());

    let target: TargetChannel;
    let threadContext: string | undefined;
    try {
      if (isThread) {
        target = { channelId, threadKey };
        threadContext = await this.fetchThreadContext(channelId, msgId);
      } else {
        const prefix = isUrl ? 'ingest' : 'research';
        const title = makeThreadTitle(`${prefix}: ${ctx.text}`);
        const { threadId: newThreadId } = await this.ipc.discordCreateThread(
          channelId,
          msgId,
          truncate(title, THREAD_NAME_MAX),
        );
        target = { channelId: newThreadId, threadKey: newThreadId };
        threadKey = newThreadId;
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'failed to resolve discord target / open thread (wiki-ingest)',
      );
      return;
    }

    await this.runWithMutex(threadKey, () =>
      this.runWikiIngestInThread(ctx, target, threadKey, isUrl, threadContext),
    );
  }

  private async runWikiIngestInThread(
    ctx: MessageContext,
    target: TargetChannel,
    threadKey: string,
    isUrl: boolean,
    threadContext?: string,
  ): Promise<void> {
    const channelLabel = ctx.channelName ?? ctx.channelId;
    const wikiDir = this.config.wikiDir;
    const channelModel = this.config.channelModels.wiki;

    const basePrompt = isUrl
      ? `다음 URL의 내용을 wiki에 추가해줘:\n\n${ctx.text.trim()}`
      : `다음 주제를 웹에서 리서치해서 wiki에 추가해줘:\n\n${ctx.text.trim()}`;
    const prompt = threadContext ? `${threadContext}\n\n${basePrompt}` : basePrompt;

    const systemAppend = buildWikiIngestSystemAppend({ isUrl });

    const stopTyping = this.startTyping(target.channelId);
    const controller = new AbortController();
    this.activeRuns.set(threadKey, controller);
    try {
      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `wiki-ingest isUrl=${isUrl}`,
        meta: { wikiDir, isUrl, model: channelModel },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `wiki-ingest isUrl=${isUrl}`,
      });

      const ingestStartMs = Date.now();
      let result;
      try {
        result = await runClaude({
          cwd: wikiDir,
          prompt,
          systemAppend,
          signal: controller.signal,
          timeoutMs: CLAUDE_TIMEOUT_MS,
          model: channelModel,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          await this.notifyCancelled(channelLabel, threadKey, target.channelId, 'wiki-ingest');
          return;
        }
        const e = err instanceof ClaudeError ? err : (err as Error);
        log.error(
          { err: e.message, channel: channelLabel, threadId: threadKey },
          'claude run failed in wiki-ingest',
        );
        logEvent(this.db, {
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
          meta: { target: 'wiki' },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
        });
        try {
          await this.safeSend(
            target.channelId,
            `wiki ingest 실패: ${truncate(e.message, 1500)}`,
          );
        } catch (sendErr) {
          log.error({ err: (sendErr as Error).message }, 'failed to post error (wiki-ingest)');
        }
        return;
      }

      // ingest 완료 후 신규 raw 파일 → context-hub topic 파일 자동 생성 (fire-and-forget)
      const contextHubPath = this.config.repoChannels.find(
        (r) => r.fullName === 'vibemafiaclub/context-hub',
      )?.localPath;
      if (contextHubPath) {
        void syncNewTopics(this.config.wikiDir, contextHubPath, ingestStartMs).catch((err) =>
          log.warn({ err: (err as Error).message }, 'topic-sync: failed after wiki-ingest'),
        );
      }

      logUsage(this.db, {
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
      });
      const footer = buildUsageFooter({
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
        model: result.model,
        modelIsDefault: !channelModel,
        rateLimits: result.rateLimits,
      });

      const chunks = splitMessage(result.text, SAFE_CHUNK_SIZE);
      if (chunks.length > 0) chunks[chunks.length - 1] += '\n' + footer;
      for (const chunk of chunks) {
        try {
          await this.safeSend(target.channelId, chunk);
        } catch (err) {
          log.error(
            { err: (err as Error).message, channel: channelLabel, threadId: threadKey },
            'failed to send response chunk (wiki-ingest)',
          );
          break;
        }
      }

      await this.sendArtifacts(target.channelId, result.artifacts);

      logEvent(this.db, {
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
        meta: { duration_seconds: result.durationMs / 1000, target: 'wiki', isUrl },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
      });
    } finally {
      this.activeRuns.delete(threadKey);
      stopTyping();
    }
  }

  // -------------------------------------------------------------------------
  // Root channel flow — no repo binding, $HOME cwd, owner-only (gated in router.ts)
  // -------------------------------------------------------------------------

  private async handleRoot(
    ctx: MessageContext,
    threadKey: string,
    msgId: string,
    channelId: string,
  ): Promise<void> {
    const isThread = ctx.threadId !== null;

    let target: TargetChannel;
    try {
      if (isThread) {
        target = { channelId, threadKey };
      } else {
        const title = makeThreadTitle(ctx.text || 'root');
        const { threadId: newThreadId } = await this.ipc.discordCreateThread(
          channelId,
          msgId,
          truncate(title, THREAD_NAME_MAX),
        );
        target = { channelId: newThreadId, threadKey: newThreadId };
        threadKey = newThreadId;
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, channel: ctx.channelName ?? ctx.channelId },
        'failed to resolve discord target / open thread (root)',
      );
      return;
    }

    const existingSession = getSession(this.db, threadKey);
    const threadContext =
      isThread && !existingSession ? await this.fetchThreadContext(channelId, msgId) : undefined;

    await this.runWithMutex(threadKey, () =>
      this.runRootInThread(ctx, target, threadKey, threadContext),
    );
  }

  private async runRootInThread(
    ctx: MessageContext,
    target: TargetChannel,
    threadKey: string,
    threadContext?: string,
  ): Promise<void> {
    const channelLabel = ctx.channelName ?? ctx.channelId;
    const cwd = os.homedir();
    const channelModel = this.config.channelModels.root;

    const sessionRow = getSession(this.db, threadKey);
    const resumeId = sessionRow?.claudeSessionId;

    const stopTyping = this.startTyping(target.channelId);
    const controller = new AbortController();
    this.activeRuns.set(threadKey, controller);

    try {
      const savedPaths = await downloadAttachments(ctx.attachments ?? []);

      const baseText = ctx.text + attachmentNote(savedPaths);
      const userMessage = threadContext ? `${threadContext}\n\n${baseText}` : baseText;

      const systemAppend = buildRootSystemAppend({ isContinuation: Boolean(resumeId) });

      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `root resume=${Boolean(resumeId)}`,
        meta: { target: 'root', resume: Boolean(resumeId), model: channelModel },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `root resume=${Boolean(resumeId)}`,
      });

      let result;
      try {
        result = await runClaude({
          cwd,
          prompt: userMessage,
          systemAppend,
          resume: resumeId,
          signal: controller.signal,
          timeoutMs: CLAUDE_TIMEOUT_MS,
          env: this.engineEnv(threadKey, 'root', true), // root channel is owner-only (router-verified)
          model: channelModel,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          await this.notifyCancelled(channelLabel, threadKey, target.channelId, 'root');
          return;
        }
        const e = err instanceof ClaudeError ? err : (err as Error);
        log.error(
          { err: e.message, channel: channelLabel, threadId: threadKey },
          'claude run failed in root',
        );
        logEvent(this.db, {
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
          meta: { target: 'root' },
        });
        emitEvent({
          ts: new Date().toISOString(),
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
        });
        try {
          await this.safeSend(
            target.channelId,
            formatEngineFailure(e.message, CLAUDE_TIMEOUT_MS, getPendingBackgroundJobsForThread(this.db, threadKey)),
          );
        } catch (sendErr) {
          log.error(
            { err: (sendErr as Error).message },
            'failed to post claude error message (root)',
          );
        }
        return;
      }

      logUsage(this.db, {
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
      });
      const usageFooter = buildUsageFooter({
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
        model: result.model,
        modelIsDefault: !channelModel,
        rateLimits: result.rateLimits,
      });

      const chunks = splitMessage(this.guardPromise(result.text, threadKey, channelLabel), SAFE_CHUNK_SIZE);
      if (chunks.length > 0) chunks[chunks.length - 1] += '\n' + usageFooter;
      for (const chunk of chunks) {
        try {
          await this.safeSend(target.channelId, chunk);
        } catch (err) {
          log.error(
            { err: (err as Error).message, channel: channelLabel, threadId: threadKey },
            'failed to send response chunk (root)',
          );
          break;
        }
      }

      await this.sendArtifacts(target.channelId, result.artifacts);

      try {
        upsertSession(this.db, {
          threadId: threadKey,
          claudeSessionId: result.sessionId,
          repo: 'root',
          cwd,
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: threadKey },
          'failed to upsert session (root)',
        );
      }

      logEvent(this.db, {
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
        meta: { duration_seconds: result.durationMs / 1000, target: 'root' },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
      });

      logEvent(this.db, {
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: result.text.slice(0, 500),
        meta: { chunks: chunks.length, target: 'root' },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'discord.message.out',
        channel: channelLabel,
        threadId: threadKey,
        summary: result.text.slice(0, 500),
      });
    } finally {
      this.activeRuns.delete(threadKey);
      stopTyping();
    }
  }

  // -------------------------------------------------------------------------
  // Graceful restart (drain → exit so Gateway spawns updated worker)
  // -------------------------------------------------------------------------

  private scheduleGracefulRestart(channelLabel: string, threadKey: string): void {
    this.draining = true;
    this.ipc.drain();
    log.info(
      { channel: channelLabel, threadId: threadKey, inFlight: this.inFlightCount },
      'SimpleClaw restart scheduled — draining in-flight work',
    );
    if (this.inFlightCount === 0) {
      process.exit(0);
    }
    // Otherwise runWithMutex finally block will call process.exit(0) when inFlightCount hits 0
  }

  // -------------------------------------------------------------------------
  // Search command
  // -------------------------------------------------------------------------

  private async handleSearchCommand(query: string, _ctx: MessageContext, channelId: string): Promise<void> {
    if (!query) {
      try { await this.safeSend(channelId, '사용법: `/search <검색어>`'); } catch { /* */ }
      return;
    }

    let results: EventSearchResult[];
    try {
      results = searchEvents(this.db, query, 15);
    } catch (err) {
      log.error({ err: (err as Error).message, query }, 'search: query failed');
      try { await this.safeSend(channelId, '검색 중 오류가 발생했습니다.'); } catch { /* */ }
      return;
    }

    if (results.length === 0) {
      try { await this.safeSend(channelId, `"${query}"에 대한 결과 없음.`); } catch { /* */ }
      return;
    }

    // Group by threadId (or channel if no thread)
    const groups = new Map<string, EventSearchResult[]>();
    for (const r of results) {
      const key = r.threadId ?? r.channel ?? '(없음)';
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    const lines: string[] = [`🔍 **"${query}"** — ${results.length}건\n`];
    for (const [key, rows] of groups) {
      const first = rows[0];
      const ts = first.ts.slice(0, 16).replace('T', ' ');
      const threadRef = first.threadId ? `<#${first.threadId}>` : (first.channel ?? key);
      lines.push(`**[${ts}]** ${threadRef}`);
      for (const r of rows.slice(0, 3)) {
        const tag = r.type.replace('discord.', '').replace('claude.', '');
        lines.push(`→ \`${tag}\`: ${r.snippet}`);
      }
      lines.push('');
    }

    const chunks = splitMessage(lines.join('\n'), SAFE_CHUNK_SIZE);
    for (const chunk of chunks) {
      try {
        await this.safeSend(channelId, chunk);
      } catch (err) {
        log.error({ err: (err as Error).message }, 'search: reply failed');
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mutex
  // -------------------------------------------------------------------------

  private async runWithMutex(key: string, work: () => Promise<void>): Promise<void> {
    const prev = this.threadLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const myPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(key, myPromise);
    this.inFlightCount++;

    try {
      await prev;
    } catch {
      // Previous job's failure shouldn't block our turn.
    }

    try {
      await work();
    } finally {
      release();
      this.inFlightCount--;
      // Only delete if we're still the head of the chain.
      if (this.threadLocks.get(key) === myPromise) {
        this.threadLocks.delete(key);
      }
      // If all work is drained and a restart was requested, exit now.
      if (this.draining && this.inFlightCount === 0) {
        process.exit(0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Thread context helper
  // -------------------------------------------------------------------------

  private async fetchThreadContext(channelId: string, _msgId: string): Promise<string | undefined> {
    const lines: string[] = [];

    // The message that started the thread (typically the mail alert body).
    try {
      const starter = await this.ipc.fetchStarterMessage(channelId);
      if (starter?.content) {
        const label = starter.authorIsBot ? '[알림]' : `[${starter.authorName}]`;
        lines.push(`${label}: ${starter.content}`);
      }
    } catch {
      // Thread may not have a starter message.
    }

    // Messages sent inside the thread before the current one.
    try {
      const fetched = await this.ipc.fetchMessages(channelId, 20);
      const sorted = [...fetched].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      for (const m of sorted) {
        if (!m.content) continue;
        const label = m.authorIsBot ? '[claw]' : `[${m.authorName}]`;
        lines.push(`${label}: ${m.content}`);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'fetchThreadContext: messages.fetch failed');
    }

    if (lines.length === 0) return undefined;
    return `[스레드 이전 내용]\n${lines.join('\n')}\n---`;
  }

  // -------------------------------------------------------------------------
  // IPC send helpers
  // -------------------------------------------------------------------------

  private async safeSend(channelId: string, content: string): Promise<void> {
    await this.ipc.discordSend(channelId, content);
  }

  private async sendArtifacts(channelId: string, artifacts: Artifact[]): Promise<void> {
    for (const a of artifacts) {
      try {
        if (a.kind === 'file' && a.path) await this.ipc.discordSendFile(channelId, a.path, a.caption);
        else if (a.kind === 'url' && a.url) await this.ipc.discordSendUrl(channelId, a.url, a.caption);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'sendArtifacts error');
      }
    }
  }

  private startTyping(channelId: string): () => void {
    this.ipc.typingStart(channelId);
    return () => this.ipc.typingStop(channelId);
  }

  // -------------------------------------------------------------------------
  // postToChannel / postMailAlert / sendFile — Worker doesn't do Discord calls
  // These are only on Gateway; however MessengerAdapter interface requires them.
  // Provide stub implementations that throw if called from Worker.
  // -------------------------------------------------------------------------

  async postToChannel(channelId: string, content: string): Promise<void> {
    // Worker shouldn't be used as a MailAlertPoster — that belongs to Gateway.
    // But if called (e.g. from schedulers that run in Worker), forward via IPC.
    await this.ipc.discordSend(channelId, content);
  }

  async postMailAlert(_args: {
    channelId: string;
    threadName: string;
    initialMessage: string;
    threadFirstMessage?: string;
    attachmentFiles?: { path: string; filename: string }[];
    senderEmail?: string;
    senderAccount?: string;
  }): Promise<{ threadId: string; firstMessageId: string }> {
    throw new Error('postMailAlert not available in Worker — use GatewayIpc');
  }

  async sendFile(_args: {
    channelId: string;
    threadId: string | null;
    filePath: string;
    caption?: string;
  }): Promise<void> {
    throw new Error('sendFile not available in Worker — use GatewayIpc');
  }
}

// ---------------------------------------------------------------------------
// Shared utilities (exported for re-use by Gateway adapter and tests)
// ---------------------------------------------------------------------------

/** @deprecated Backwards compat: older skills/memories may still emit __CLAW_RESTART__. */
const LEGACY_RESTART_MARKER = '__CLAW_RESTART__';

/**
 * Detect & strip the SimpleClaw restart marker. Marker must appear on its own
 * (anywhere in the body, but typically the last line). The marker line is
 * removed entirely; surrounding whitespace is normalized.
 *
 * Also accepts the legacy __CLAW_RESTART__ marker for backwards compatibility.
 */
export function extractRestartMarker(text: string): { text: string; restart: boolean } {
  let idx = text.lastIndexOf(SIMPLECLAW_RESTART_MARKER);
  let markerLen = SIMPLECLAW_RESTART_MARKER.length;
  if (idx === -1) {
    idx = text.lastIndexOf(LEGACY_RESTART_MARKER);
    markerLen = LEGACY_RESTART_MARKER.length;
  }
  if (idx === -1) return { text, restart: false };
  const before = text.slice(0, idx).replace(/\s+$/, '');
  const after = text.slice(idx + markerLen).replace(/^\s+/, '');
  const cleaned = after.length > 0 ? `${before}\n${after}` : before;
  return { text: cleaned.trimEnd(), restart: true };
}

const execFileAsync = promisify(execFile);

/**
 * Returns true if the most recent commit in the repo touched src/ or key config files.
 * Used as a fallback to catch cases where the Claude response omitted the restart marker.
 */
async function checkSrcModifiedInLastCommit(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      cwd,
    });
    const files = stdout.split('\n').filter(Boolean);
    return files.some(
      (f) => f.startsWith('src/') || f === 'package.json' || f === 'tsconfig.json',
    );
  } catch {
    return false;
  }
}

// Re-export types for downstream consumers (e.g. gmail adapter).
export type { SerializedMessage };

// Keep TextBasedChannel re-export stub for backward compat
export type TextBasedChannel = Record<string, unknown>;

// Suppress unused import warning for spawn (used in legacy code)
void spawn;
