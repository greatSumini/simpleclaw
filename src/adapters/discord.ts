import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type Database from 'better-sqlite3';

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
import {
  buildRepoWorkSystemAppend,
  buildClawMaintenanceSystemAppend,
  buildWikiIngestSystemAppend,
  buildAnalysisSystemAppend,
  CLAW_RESTART_MARKER,
} from '../orchestrator/prompt.js';
import {
  loadCandidateContext,
  saveMemory,
  extractKeywords,
  recordMemoryReferences,
  updateMemoryScore,
  updateCandidateScore,
  markMemoriesReferenced,
  getMemoriesForThread,
  channelScope,
  repoScope,
  GLOBAL_SCOPE,
} from '../state/memories.js';
import { loadRelevantMemoriesHybrid } from '../state/memories-hybrid.js';
import { detectSkill, truncateForCache } from '../orchestrator/skill-detector.js';
import {
  buildConversationTranscript,
  buildAnalysisPrompt,
  parseSkillProposals,
  stripSkillProposalsBlock,
  parseMemoryScores,
  stripMemoryScoresBlock,
} from '../orchestrator/auto-analysis.js';
import { extractAndSaveFacts } from '../orchestrator/fact-extractor.js';
import {
  insertSkillProposal,
  getSkillProposal,
  updateSkillProposalStatus,
  type SkillProposal,
} from '../state/skill-proposals.js';
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
import {
  upsertSessionAnalysis,
  findEligibleSessionsForAnalysis,
  type EligibleSession,
} from '../state/session-analyses.js';
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

const CREATE_SKILL_PREFIX = 'create-skill';

export function buildCreateSkillButtonId(proposalId: number): string {
  return `${CREATE_SKILL_PREFIX}:${proposalId}`;
}

export function parseCreateSkillButtonId(customId: string): number | null {
  if (!customId.startsWith(`${CREATE_SKILL_PREFIX}:`)) return null;
  const id = parseInt(customId.slice(CREATE_SKILL_PREFIX.length + 1), 10);
  return Number.isFinite(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const SAFE_CHUNK_SIZE = 1900; // headroom for the [i/N]\n prefix
const THREAD_NAME_MAX = 90; // Discord limit is 100; leave headroom
const CLAUDE_TIMEOUT_MS = 1_800_000; // 30 min

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

export class DiscordAdapter implements MessengerAdapter {
  readonly platform = 'discord';
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly ipc: WorkerIpc;
  /** Per-thread (or per-channel for DMs) mutex chain. */
  private readonly threadLocks: Map<string, Promise<void>> = new Map();
  /** Number of Claude runs currently executing inside runWithMutex. */
  private inFlightCount = 0;
  /** Set when a drain/restart has been requested. */
  private draining = false;
  private analysisTimer: NodeJS.Timeout | null = null;

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
        void this.onIpcReaction(msg.emoji, msg.msgId, msg.channelId, msg.userId, msg.isOwner).catch((err) => {
          log.error({ err: (err as Error).message }, 'discord reaction handler crashed');
        });
      } else if (msg.type === 'discord.button') {
        void this.onIpcButton(msg.customId, msg.channelId, msg.msgId, msg.interactionId, msg.token).catch((err) => {
          log.error({ err: (err as Error).message }, 'discord button interaction handler crashed');
        });
      }
    });
    this.startAnalysisPoller();
    this.ipc.ready();
  }

  async stop(): Promise<void> {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
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

    // create-skill button
    const proposalId = parseCreateSkillButtonId(customId);
    if (proposalId !== null) {
      await this.handleCreateSkillButton(interactionId, token, proposalId);
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
  ): Promise<void> {
    if (!isOwner) return;
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
      }
      return;
    }

    // General (non-mail) thread: ❌ deletes the thread channel.
    if (emoji !== '❌') return;

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

    // !기억 shortcut — save to memory Layer 1.
    if (ctx.text.startsWith('!기억')) {
      const value = ctx.text.slice('!기억'.length).trim();
      await this.handleRememberCommand(value, ctx, channelId);
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
      case 'claw-maintenance':
        await this.handleClawMaintenance(ctx, threadKey, msgId, channelId);
        return;
      case 'wiki-ingest':
        await this.handleWikiIngest(ctx, threadKey, msgId, channelId);
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
    await this.runWithMutex(threadKey, () =>
      this.runRepoWorkInThread(ctx, repo, target, threadKey, threadContext),
    );
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

    // Look up existing claude session.
    const sessionRow = getSession(this.db, threadKey);
    const resumeId = sessionRow?.claudeSessionId;

    // Typing indicator.
    const stopTyping = this.startTyping(target.channelId);

    try {
      const skillsDir = path.join(this.config.clawRepoPath, 'skills');

      // 첨부파일 다운로드 + skill 탐지 병렬 실행
      const [savedPaths, skillResult] = await Promise.all([
        downloadAttachments(ctx.attachments ?? []),
        detectSkill({
          userMessage: ctx.text,
          previousResponse: sessionRow?.lastResponse ?? null,
          cachedSkill: sessionRow?.lastSkill ?? null,
          skillsDir,
        }),
      ]);

      const baseText = ctx.text + attachmentNote(savedPaths);
      const userMessage = threadContext ? `${threadContext}\n\n${baseText}` : baseText;

      // Load relevant memories for context injection (Layer 2 hybrid + top Layer 1 candidates).
      const scopes = [channelScope(threadKey), repoScope(repo.fullName), GLOBAL_SCOPE];
      const relevantMemories = await loadRelevantMemoriesHybrid(this.db, scopes, ctx.text);
      const relevantCandidates = loadCandidateContext(this.db, scopes, ctx.text);
      const allMemories = [...relevantMemories, ...relevantCandidates];

      const baseSystemAppend = buildRepoWorkSystemAppend({
        userMessage,
        repo,
        isContinuation: Boolean(resumeId),
        memories: allMemories,
      });
      const systemAppend = skillResult.content
        ? `# 활성 Skill: ${skillResult.skill}\n\n${skillResult.content}\n\n---\n${baseSystemAppend}`
        : baseSystemAppend;

      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `repo=${repo.fullName} resume=${Boolean(resumeId)} memories=${allMemories.length}`,
        meta: { repo: repo.fullName, resume: Boolean(resumeId), memoryCount: allMemories.length },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `repo=${repo.fullName} resume=${Boolean(resumeId)}`,
      });

      // For (btw) messages: snapshot session files before running so we can roll back after.
      const btwSnapshot = isBtw ? await snapshotSessionFiles(repo.localPath) : undefined;

      let result;
      try {
        if (repo.engine === 'tmux') {
          const tmuxResult = await tmuxRunner.run({
            cwd: repo.localPath,
            prompt: userMessage,
            systemAppend,
            sessionKey: threadKey,
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
          };
        } else {
          const runner = repo.engine === 'codex' ? runCodex : runClaude;
          result = await runner({
            cwd: repo.localPath,
            prompt: userMessage,
            systemAppend,
            resume: resumeId,
            timeoutMs: CLAUDE_TIMEOUT_MS,
          });
        }
      } catch (err) {
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
          await this.safeSend(target.channelId, `claude run failed: ${truncate(e.message, 1500)}`);
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
      const usageFooter = buildUsageFooter(this.db, {
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
      });

      // Post the response; capture last sent message ID for memory reference tracking.
      const chunks = splitMessage(result.text, SAFE_CHUNK_SIZE);
      if (chunks.length > 0) chunks[chunks.length - 1] += '\n' + usageFooter;
      let lastSentMessageId: string | null = null;
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        try {
          if (isLast && relevantMemories.length > 0) {
            const sent = await this.safeSendWithId(target.channelId, chunks[i]);
            if (sent) lastSentMessageId = sent.messageId ?? null;
          } else {
            await this.safeSend(target.channelId, chunks[i]);
          }
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

      // Track memory references for auto-analysis scoring later.
      if (allMemories.length > 0 && lastSentMessageId) {
        try {
          markMemoriesReferenced(this.db, relevantMemories.map((m) => m.id));
          // Boost Layer 1 candidates that were loaded as context — relevance is itself a quality signal.
          for (const c of relevantCandidates) {
            updateCandidateScore(this.db, c.id, 5, threadKey);
          }
          recordMemoryReferences(
            this.db,
            lastSentMessageId,
            [
              ...relevantMemories.map((m) => ({ id: m.id, layer: 'memory' as const })),
              ...relevantCandidates.map((c) => ({ id: c.id, layer: 'candidate' as const })),
            ],
            threadKey,
          );
        } catch (err) {
          log.error({ err: (err as Error).message }, 'failed to record memory references');
        }
      }

      // (btw) mode: restore session files to pre-run state so this exchange is ephemeral.
      if (isBtw && btwSnapshot) {
        await restoreSessionFiles(repo.localPath, btwSnapshot).catch((err: Error) =>
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
            lastSkill: skillResult.skill,
            lastResponse: truncateForCache(result.text),
          });
        } catch (err) {
          log.error(
            { err: (err as Error).message, threadId: threadKey },
            'failed to upsert session',
          );
        }
      }

      // Fire-and-forget fact extraction (non-blocking, best-effort) — skip for (btw).
      if (!isBtw) {
        extractAndSaveFacts(
          this.db,
          this.config.clawRepoPath,
          repoScope(repo.fullName),
          ctx.text,
          result.text,
        ).catch((err: Error) => log.debug({ err: err.message }, 'fact-extractor: skipped'));
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
      stopTyping();
    }
  }

  // -------------------------------------------------------------------------
  // Claw self-maintenance flow
  // -------------------------------------------------------------------------

  private async handleClawMaintenance(
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
        const title = makeThreadTitle(ctx.text || 'claw 유지보수');
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
        'failed to resolve discord target / open thread (claw-maintenance)',
      );
      return;
    }

    const existingSession = getSession(this.db, threadKey);
    const threadContext =
      isThread && !existingSession ? await this.fetchThreadContext(channelId, msgId) : undefined;

    await this.runWithMutex(threadKey, () =>
      this.runClawMaintenanceInThread(ctx, target, threadKey, threadContext),
    );
  }

  private async runClawMaintenanceInThread(
    ctx: MessageContext,
    target: TargetChannel,
    threadKey: string,
    threadContext?: string,
  ): Promise<void> {
    const channelLabel = ctx.channelName ?? ctx.channelId;
    const cwd = this.config.clawRepoPath;

    const sessionRow = getSession(this.db, threadKey);
    const resumeId = sessionRow?.claudeSessionId;

    const stopTyping = this.startTyping(target.channelId);

    try {
      const skillsDir = path.join(cwd, 'skills');

      // 첨부파일 다운로드 + skill 탐지 병렬 실행
      const [savedPaths, skillResult] = await Promise.all([
        downloadAttachments(ctx.attachments ?? []),
        detectSkill({
          userMessage: ctx.text,
          previousResponse: sessionRow?.lastResponse ?? null,
          cachedSkill: sessionRow?.lastSkill ?? null,
          skillsDir,
        }),
      ]);

      const baseText = ctx.text + attachmentNote(savedPaths);
      const userMessage = threadContext ? `${threadContext}\n\n${baseText}` : baseText;

      // Load relevant memories for context injection (claw scope, Layer 2 hybrid + top Layer 1).
      const clawScopes = [channelScope(threadKey), repoScope('greatSumini/claw'), GLOBAL_SCOPE];
      const relevantMemoriesClaw = await loadRelevantMemoriesHybrid(this.db, clawScopes, ctx.text);
      const relevantCandidatesClaw = loadCandidateContext(this.db, clawScopes, ctx.text);
      const allMemoriesClaw = [...relevantMemoriesClaw, ...relevantCandidatesClaw];

      const baseSystemAppend = buildClawMaintenanceSystemAppend({
        isContinuation: Boolean(resumeId),
        memories: allMemoriesClaw,
      });
      const systemAppend = skillResult.content
        ? `# 활성 Skill: ${skillResult.skill}\n\n${skillResult.content}\n\n---\n${baseSystemAppend}`
        : baseSystemAppend;

      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `claw-maintenance resume=${Boolean(resumeId)}`,
        meta: { target: 'claw', resume: Boolean(resumeId) },
      });
      emitEvent({
        ts: new Date().toISOString(),
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `claw-maintenance resume=${Boolean(resumeId)}`,
      });

      let result;
      try {
        result = await runClaude({
          cwd,
          prompt: userMessage,
          systemAppend,
          resume: resumeId,
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
      } catch (err) {
        const e = err instanceof ClaudeError ? err : (err as Error);
        log.error(
          { err: e.message, channel: channelLabel, threadId: threadKey },
          'claude run failed in claw-maintenance',
        );
        logEvent(this.db, {
          type: 'claude.error',
          channel: channelLabel,
          threadId: threadKey,
          summary: e.message.slice(0, 300),
          meta: { target: 'claw' },
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
            `claude run failed: ${truncate(e.message, 1500)}`,
          );
        } catch (sendErr) {
          log.error(
            { err: (sendErr as Error).message },
            'failed to post claude error message (claw-maintenance)',
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
      const clawUsageFooter = buildUsageFooter(this.db, {
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
      });

      const chunks = splitMessage(visibleText, SAFE_CHUNK_SIZE);
      if (chunks.length > 0) chunks[chunks.length - 1] += '\n' + clawUsageFooter;
      let lastSentMsgIdClaw: string | null = null;
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        try {
          if (isLast && relevantMemoriesClaw.length > 0) {
            const sent = await this.safeSendWithId(target.channelId, chunks[i]);
            if (sent) lastSentMsgIdClaw = sent.messageId ?? null;
          } else {
            await this.safeSend(target.channelId, chunks[i]);
          }
        } catch (err) {
          log.error(
            { err: (err as Error).message, channel: channelLabel, threadId: threadKey },
            'failed to send response chunk (claw-maintenance)',
          );
          break;
        }
      }

      // Send artifact attachments/links after text.
      await this.sendArtifacts(target.channelId, result.artifacts);

      // Track memory references for auto-analysis scoring later.
      if (allMemoriesClaw.length > 0 && lastSentMsgIdClaw) {
        try {
          markMemoriesReferenced(this.db, relevantMemoriesClaw.map((m) => m.id));
          for (const c of relevantCandidatesClaw) {
            updateCandidateScore(this.db, c.id, 5, threadKey);
          }
          recordMemoryReferences(
            this.db,
            lastSentMsgIdClaw,
            [
              ...relevantMemoriesClaw.map((m) => ({ id: m.id, layer: 'memory' as const })),
              ...relevantCandidatesClaw.map((c) => ({ id: c.id, layer: 'candidate' as const })),
            ],
            threadKey,
          );
        } catch (err) {
          log.error({ err: (err as Error).message }, 'failed to record memory references (claw)');
        }
      }

      try {
        upsertSession(this.db, {
          threadId: threadKey,
          claudeSessionId: result.sessionId,
          repo: 'greatSumini/claw',
          cwd,
          lastSkill: skillResult.skill,
          lastResponse: truncateForCache(visibleText),
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: threadKey },
          'failed to upsert session (claw-maintenance)',
        );
      }

      logEvent(this.db, {
        type: 'claude.result',
        channel: channelLabel,
        threadId: threadKey,
        summary: `${result.durationMs}ms ${visibleText.length}chars${restart ? ' [restart]' : ''}`,
        meta: {
          duration_seconds: result.durationMs / 1000,
          target: 'claw',
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
        meta: { chunks: chunks.length, target: 'claw', restart },
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

    const basePrompt = isUrl
      ? `다음 URL의 내용을 wiki에 추가해줘:\n\n${ctx.text.trim()}`
      : `다음 주제를 웹에서 리서치해서 wiki에 추가해줘:\n\n${ctx.text.trim()}`;
    const prompt = threadContext ? `${threadContext}\n\n${basePrompt}` : basePrompt;

    const systemAppend = buildWikiIngestSystemAppend({ isUrl });

    const stopTyping = this.startTyping(target.channelId);
    try {
      logEvent(this.db, {
        type: 'claude.invoke',
        channel: channelLabel,
        threadId: threadKey,
        summary: `wiki-ingest isUrl=${isUrl}`,
        meta: { wikiDir, isUrl },
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
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
      } catch (err) {
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
      const footer = buildUsageFooter(this.db, {
        sessionId: result.sessionId,
        contextWindowUsed: result.contextWindowUsed,
        contextWindowMax: result.contextWindowMax,
        costUsd: result.costUsd,
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
      'claw restart scheduled — draining in-flight work',
    );
    if (this.inFlightCount === 0) {
      process.exit(0);
    }
    // Otherwise runWithMutex finally block will call process.exit(0) when inFlightCount hits 0
  }

  // -------------------------------------------------------------------------
  // Memory commands
  // -------------------------------------------------------------------------

  private async handleRememberCommand(
    value: string,
    ctx: MessageContext,
    channelId: string,
  ): Promise<void> {
    if (!value) {
      await this.safeSend(channelId, '사용법: `!기억 <기억할 내용>`');
      return;
    }
    try {
      // 명시적 !기억 → Layer 2 직접 저장 (score 65, 즉시 주입 가능)
      const scope = ctx.threadId ? channelScope(ctx.threadId) : GLOBAL_SCOPE;
      const key = value.slice(0, 80);
      const tags = extractKeywords(value);
      saveMemory(this.db, { scope, key, value, tags, score: 65, source: 'explicit' });
      await this.safeSend(channelId, `📝 기억했습니다 (Layer 2, 즉시 활성): \`${value.slice(0, 100)}\``);
      log.info({ scope, key: key.slice(0, 40) }, 'memory saved to Layer 2 via !기억');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'handleRememberCommand: failed');
      await this.safeSend(channelId, '❌ 저장 실패: ' + (err as Error).message);
    }
  }

  // Skill creation (button handler)
  // -------------------------------------------------------------------------

  private async handleCreateSkillButton(
    interactionId: string,
    token: string,
    proposalId: number,
  ): Promise<void> {
    const proposal = getSkillProposal(this.db, proposalId);
    if (!proposal) {
      await this.ipc.interactionReply(interactionId, token, '제안을 찾을 수 없습니다 (이미 처리됨?).', true);
      return;
    }
    if (proposal.status !== 'pending') {
      await this.ipc.interactionReply(interactionId, token, `이미 처리됨: ${proposal.status}`, true);
      return;
    }

    // Acknowledge immediately (ephemeral)
    await this.ipc.interactionReply(interactionId, token, '✅ Skill 생성 중...', true);

    try {
      if (proposal.kind === 'claw') {
        await this.createClawSkill(proposal);
      } else {
        await this.createRepoSkill(proposal);
      }
      updateSkillProposalStatus(this.db, proposalId, 'created');
      log.info({ proposalId, name: proposal.name, kind: proposal.kind }, 'skill proposal created');
    } catch (err) {
      log.error({ err: (err as Error).message, proposalId }, 'create-skill button: failed');
    }
  }

  private async createClawSkill(proposal: SkillProposal): Promise<void> {
    const skillDir = path.join(this.config.clawRepoPath, 'skills', proposal.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), proposal.content, 'utf8');

    const repoPath = this.config.clawRepoPath;
    await execFileAsync('git', ['-C', repoPath, 'add', `skills/${proposal.name}/SKILL.md`]);
    await execFileAsync('git', ['-C', repoPath, 'commit', '-m', `feat: skill 자동 생성 — ${proposal.name}`]);
    await execFileAsync('git', ['-C', repoPath, 'push']);
  }

  private async createRepoSkill(proposal: SkillProposal): Promise<void> {
    if (!proposal.repoFullName) throw new Error('repoFullName required for repo skill');
    const repoEntry = this.config.repoChannels.find((r) => r.fullName === proposal.repoFullName);
    if (!repoEntry) throw new Error(`repo not registered: ${proposal.repoFullName}`);

    const skillDir = path.join(repoEntry.localPath, '.claude', 'skills', proposal.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), proposal.content, 'utf8');

    const repoPath = repoEntry.localPath;
    await execFileAsync('git', ['-C', repoPath, 'add', `.claude/skills/${proposal.name}/SKILL.md`]);
    await execFileAsync('git', ['-C', repoPath, 'commit', '-m', `feat: skill 자동 생성 — ${proposal.name}`]);
    await execFileAsync('git', ['-C', repoPath, 'push']);
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
  // Auto-analysis poller
  // -------------------------------------------------------------------------

  private startAnalysisPoller(): void {
    const INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes
    this.analysisTimer = setInterval(() => {
      void this.runAnalysisCycle().catch((err) => {
        log.error({ err: (err as Error).message }, 'analysis poller crashed');
      });
    }, INTERVAL_MS);
    if (this.analysisTimer && typeof this.analysisTimer.unref === 'function') {
      this.analysisTimer.unref();
    }
  }

  private async runAnalysisCycle(): Promise<void> {
    if (this.draining) return;

    let eligible: EligibleSession[];
    try {
      eligible = findEligibleSessionsForAnalysis(this.db);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'analysis: DB query failed');
      return;
    }

    for (const session of eligible) {
      if (this.draining) break;
      try {
        await this.analyzeSession(session);
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: session.threadId },
          'analysis: session analysis failed',
        );
      }
    }
  }

  private async analyzeSession(session: EligibleSession): Promise<void> {
    const { threadId, userMsgCount, repo } = session;
    const repoLabel = repo ?? 'unknown';
    log.info({ threadId, userMsgCount, repo: repoLabel }, 'analysis: starting');

    const transcript = buildConversationTranscript(this.db, threadId);
    const injectedMemories = getMemoriesForThread(this.db, threadId);
    const prompt = buildAnalysisPrompt(threadId, transcript, repoLabel, injectedMemories);
    const systemAppend = buildAnalysisSystemAppend();

    let result;
    try {
      result = await runClaude({
        cwd: this.config.clawRepoPath,
        prompt,
        systemAppend,
        timeoutMs: CLAUDE_TIMEOUT_MS,
      });
    } catch (err) {
      log.error({ err: (err as Error).message, threadId }, 'analysis: claude run failed');
      return;
    }

    const { text: visibleText } = extractRestartMarker(result.text);

    // Apply memory scores from analysis before stripping blocks.
    const memoryScores = parseMemoryScores(visibleText);
    for (const { id, layer, delta } of memoryScores) {
      if (delta === 0) continue;
      try {
        if (layer === 'memory') {
          updateMemoryScore(this.db, id, delta, threadId);
        } else {
          updateCandidateScore(this.db, id, delta, threadId);
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, id, layer, delta }, 'analysis: failed to apply memory score');
      }
    }
    if (memoryScores.length > 0) {
      log.info({ threadId, count: memoryScores.length }, 'analysis: memory scores applied');
    }

    // Parse skill proposals before stripping blocks from display text.
    const proposals = parseSkillProposals(visibleText);
    const displayText = stripSkillProposalsBlock(stripMemoryScoresBlock(visibleText));

    const repoShort = repoLabel.split('/').pop() ?? repoLabel;
    const dateStr = new Date().toISOString().slice(0, 10);

    // 1. Post the full report to a new thread in the claw channel.
    let analysisThreadId: string | null = null;
    try {
      const header = `**[자동 분석 리포트]** — \`${repoLabel}\` · 원본: <#${threadId}>\n\n`;
      const chunks = splitMessage(header + displayText, SAFE_CHUNK_SIZE);
      const clawOrGeneral = this.config.clawChannelId ?? this.config.generalChannelId;
      const { messageId: firstMsgId } = await this.ipc.discordSend(clawOrGeneral, chunks[0] ?? '');
      if (firstMsgId) {
        const threadName = truncate(`[분석] ${repoShort} · ${dateStr}`, THREAD_NAME_MAX);
        const { threadId: newAnalysisThreadId } = await this.ipc.discordCreateThread(
          clawOrGeneral,
          firstMsgId,
          threadName,
        );
        analysisThreadId = newAnalysisThreadId;

        for (const chunk of chunks.slice(1)) {
          try {
            await this.ipc.discordSend(analysisThreadId, chunk);
          } catch (err) {
            log.error({ err: (err as Error).message }, 'analysis: claw thread chunk send failed');
          }
        }

        // Add skill proposal buttons if any were detected.
        if (proposals.length > 0) {
          try {
            const buttons = proposals.map((p) => {
              const id = insertSkillProposal(this.db, {
                kind: p.kind,
                name: p.name,
                description: p.description,
                content: p.content,
                repoFullName: p.repoFullName,
                sourceThreadId: threadId,
              });
              const emoji = p.kind === 'claw' ? '✨' : '📦';
              const label = truncate(
                `${emoji} ${p.kind === 'claw' ? 'Claw' : 'Repo'} skill: ${p.name}`,
                80,
              );
              return {
                type: 2,
                style: 1,
                label,
                custom_id: buildCreateSkillButtonId(id),
              };
            });

            // Discord limits 5 buttons per row; split into rows of 5.
            const componentRows: object[] = [];
            for (let i = 0; i < buttons.length; i += 5) {
              componentRows.push({
                type: 1,
                components: buttons.slice(i, i + 5),
              });
            }

            await this.ipc.discordSendComponents(
              analysisThreadId,
              'Skill 후보 — 클릭하면 자동 생성됩니다:',
              componentRows,
            );
          } catch (err) {
            log.error({ err: (err as Error).message }, 'analysis: failed to post skill proposal buttons');
          }
        }
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'analysis: failed to post to claw channel');
    }

    // 2. Notify the original thread with a link to the claw channel analysis thread.
    try {
      const notice = analysisThreadId
        ? `**[자동 분석 리포트]** 작성 완료 → <#${analysisThreadId}>`
        : `**[자동 분석 리포트]** 작성 완료 (claw 채널 확인)`;
      await this.ipc.discordSend(threadId, notice);
    } catch (err) {
      log.warn({ err: (err as Error).message, threadId }, 'analysis: original thread notify failed');
    }

    upsertSessionAnalysis(this.db, {
      sourceThreadId: threadId,
      analysisSessionId: result.sessionId,
      analyzedAt: new Date().toISOString(),
      userMsgCount,
      status: 'done',
    });

    log.info({ threadId, sessionId: result.sessionId, analysisThreadId }, 'analysis: posted to claw channel');
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

  private async safeSendWithId(channelId: string, content: string): Promise<{ messageId?: string }> {
    return this.ipc.discordSend(channelId, content);
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

/**
 * Detect & strip the claw restart marker. Marker must appear on its own
 * (anywhere in the body, but typically the last line). The marker line is
 * removed entirely; surrounding whitespace is normalized.
 */
export function extractRestartMarker(text: string): { text: string; restart: boolean } {
  const idx = text.lastIndexOf(CLAW_RESTART_MARKER);
  if (idx === -1) return { text, restart: false };
  const before = text.slice(0, idx).replace(/\s+$/, '');
  const after = text.slice(idx + CLAW_RESTART_MARKER.length).replace(/^\s+/, '');
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
