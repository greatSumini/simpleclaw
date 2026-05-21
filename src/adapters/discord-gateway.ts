/**
 * Gateway-side Discord adapter.
 * Holds the Discord.js WebSocket client, forwards events to Worker via IPC,
 * and handles Discord API requests from Worker.
 */

import path from 'node:path';
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Routes,
  type ButtonInteraction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import type Database from 'better-sqlite3';

import type { AppConfig } from '../config.js';
import { log } from '../log.js';
import { runClaude, ClaudeError } from '../claude.js';
import { GatewayIpc } from '../ipc/server.js';
import type { W2G, SerializedMessage } from '../ipc/types.js';
import type { MailAlertPoster } from '../messenger/types.js';
import {
  getPendingMessages,
  deleteQueuedMessage,
} from '../state/message-queue.js';
import { logEvent } from '../state/events.js';
import { logUsage, buildUsageFooter } from '../state/usage.js';
import { buildWikiScanSystemAppend } from '../orchestrator/prompt.js';
import { splitMessage, truncate, makeThreadTitle } from './discord.js';

// Re-export MailAlertPoster alias for backward compat
export type { MailAlertPoster as DiscordPoster };

const SAFE_CHUNK_SIZE = 1900;
const THREAD_NAME_MAX = 90;
const DEFAULT_AUTO_ARCHIVE_MIN = 1440;
const TYPING_REFRESH_MS = 9_000;

interface DiscordGatewayAdapterOpts {
  config: AppConfig;
  db: Database.Database;
  ipc: GatewayIpc;
}

export class DiscordGatewayAdapter implements MailAlertPoster {
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly client: Client;
  private readonly ipc: GatewayIpc;
  private started = false;
  private stopped = false;
  /** In-progress wiki-scan task (if any). Awaited in stop() before destroying the Discord client. */
  private wikiScanTask: Promise<void> | null = null;
  /** channelId → cleanup function for ongoing typing loops */
  private typingLoops = new Map<string, () => void>();

  constructor(opts: DiscordGatewayAdapterOpts) {
    this.config = opts.config;
    this.db = opts.db;
    this.ipc = opts.ipc;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.client.on(Events.MessageCreate, (msg) => {
      void this.onMessage(msg).catch((err) => {
        log.error(
          { err: (err as Error).message, stack: (err as Error).stack },
          'gateway onMessage handler crashed',
        );
      });
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isButton()) return;
      void this.onButtonInteraction(interaction as ButtonInteraction).catch((err) => {
        log.error(
          { err: (err as Error).message },
          'gateway button interaction handler crashed',
        );
      });
    });

    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.onReactionAdd(reaction, user).catch((err) => {
        log.error({ err: (err as Error).message }, 'gateway reaction handler crashed');
      });
    });

    this.client.on(Events.ShardError, (err, shardId) => {
      log.error({ err: err.message, shardId }, 'discord shard error');
    });

    this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
      log.warn(
        { shardId, code: closeEvent?.code, reason: closeEvent?.reason },
        'discord shard disconnected',
      );
    });

    this.client.on(Events.Error, (err) => {
      log.error({ err: err.message }, 'discord client error');
    });

    let rejectReady: ((err: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      this.client.once(Events.ClientReady, () => {
        log.info(
          { user: this.client.user?.tag ?? '(unknown)' },
          'Discord ready (gateway)',
        );
        resolve();
      });
    });

    try {
      await Promise.all([
        this.client.login(this.config.env.DISCORD_BOT_TOKEN).then(
          () => undefined,
          (err: Error) => {
            if (rejectReady) rejectReady(err);
            throw err;
          },
        ),
        ready,
      ]);
    } catch (err) {
      this.started = false;
      throw err;
    }

    // Register IPC discord handler AFTER Discord is ready
    this.ipc.setDiscordHandler((req) => this.handleWorkerRequest(req));

    // Replay queued messages when worker first becomes ready
    this.ipc.once('worker:ready', () => {
      void this.processMessageQueue().catch((err) => {
        log.error({ err: (err as Error).message }, 'processMessageQueue crashed');
      });
    });

  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;

    // Wait for in-progress wiki-scan before destroying the Discord client.
    // The scan posts results via thread.send(), which needs the client alive.
    if (this.wikiScanTask) {
      log.info('wiki-scan: shutdown pending — waiting for in-progress scan (max 3 min)');
      try {
        await Promise.race([
          this.wikiScanTask,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 3 * 60 * 1000),
          ),
        ]);
        log.info('wiki-scan: completed before Discord client shutdown');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'wiki-scan: timed out or failed during shutdown wait');
      }
    }

    // Stop all typing loops
    for (const cleanup of this.typingLoops.values()) {
      cleanup();
    }
    this.typingLoops.clear();
    try {
      this.client.removeAllListeners();
      await this.client.destroy();
    } finally {
      log.info('Discord gateway stopped');
    }
  }

  // -------------------------------------------------------------------------
  // Discord event handlers — forward to Worker via IPC
  // -------------------------------------------------------------------------

  private async onMessage(msg: Message): Promise<void> {
    log.debug(
      { channelId: msg.channelId, authorId: msg.author?.id, isBot: msg.author?.bot },
      'gateway: MessageCreate received',
    );
    if (msg.author?.bot) return;
    if (!this.client.user) return;
    if (msg.author.id === this.client.user.id) return;

    const ownerId = this.config.env.DISCORD_OWNER_USER_ID;
    if (msg.author.id !== ownerId && !this.isAllowedUser(msg)) {
      log.debug(
        { channelId: msg.channelId, authorId: msg.author?.id, ownerId },
        'gateway: message filtered out (not owner, not allowlisted)',
      );
      return;
    }

    const ctx = this.buildContext(msg);
    const channel = msg.channel;
    const isDm = channel.isDMBased();
    const isThread = channel.isThread();

    // Determine threadKey (same logic as original onMessage)
    let threadKey: string;
    if (isDm || isThread) {
      threadKey = channel.id;
    } else {
      // Top-level — threadKey is the channel itself (thread will be created by Worker)
      threadKey = channel.id;
    }

    this.ipc.forwardEvent({
      type: 'discord.message',
      ctx,
      threadKey,
      msgId: msg.id,
      channelId: msg.channelId,
    });
  }

  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot) return;
    if (user.id !== this.config.env.DISCORD_OWNER_USER_ID) return;

    const emoji = reaction.emoji.name;
    if (emoji !== '✅' && emoji !== '❌') return;

    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

    this.ipc.forwardEvent({
      type: 'discord.reaction',
      emoji: emoji ?? '',
      msgId: msg.id,
      channelId: msg.channelId,
      userId: user.id,
      isOwner: true,
    });
  }

  private async onButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    this.ipc.forwardEvent({
      type: 'discord.button',
      customId: interaction.customId,
      channelId: interaction.channelId,
      msgId: interaction.message.id,
      interactionId: interaction.id,
      token: interaction.token,
    });
  }

  // -------------------------------------------------------------------------
  // Allowlist check — true if the message author is permitted for this channel
  // -------------------------------------------------------------------------

  private isAllowedUser(msg: Message): boolean {
    const channel = msg.channel;
    const routingChannelId = channel.isThread()
      ? (channel.parentId ?? channel.id)
      : channel.id;
    const repo = this.config.repoChannels.find((r) => r.channelId === routingChannelId);
    return repo?.allowedUserIds?.includes(msg.author.id) ?? false;
  }

  // -------------------------------------------------------------------------
  // Build MessageContext (copied from original discord.ts)
  // -------------------------------------------------------------------------

  private buildContext(msg: Message) {
    const channel = msg.channel;
    const isDm = channel.isDMBased();
    const isThread = channel.isThread();

    let channelName: string | undefined;
    if (isDm) {
      channelName = 'dm';
    } else if (isThread) {
      const parentId = channel.parentId ?? '';
      const registered = this.config.repoChannels.find((r) => r.channelId === parentId);
      channelName =
        ('name' in channel && typeof channel.name === 'string' ? channel.name : undefined) ??
        registered?.channelName;
    } else {
      const registered = this.config.repoChannels.find((r) => r.channelId === channel.id);
      channelName =
        ('name' in channel && typeof channel.name === 'string' ? channel.name : undefined) ??
        registered?.channelName ??
        (channel.id === this.config.generalChannelId ? 'general' : undefined);
    }

    const ourId = this.client.user?.id ?? '';
    const isMention =
      (ourId !== '' && msg.mentions.users.has(ourId)) ||
      msg.mentions.repliedUser?.id === ourId;

    const cleanedText = stripLeadingMention(msg.content ?? '', ourId);

    let routingChannelId: string;
    let threadId: string | null;
    if (isDm) {
      routingChannelId = channel.id;
      threadId = null;
    } else if (isThread) {
      routingChannelId = channel.parentId ?? channel.id;
      threadId = channel.id;
    } else {
      routingChannelId = channel.id;
      threadId = null;
    }

    const attachments = Array.from(msg.attachments.values()).map((a) => ({
      name: a.name ?? 'attachment',
      url: a.url,
    }));

    return {
      platform: 'discord' as const,
      channelId: routingChannelId,
      channelName,
      threadId,
      authorId: msg.author.id,
      authorName: msg.author.username ?? msg.author.id,
      text: cleanedText,
      isMention,
      isDm,
      isBot: false as const,
      attachments,
    };
  }

  // -------------------------------------------------------------------------
  // Worker request handler (Discord API calls)
  // -------------------------------------------------------------------------

  private async handleWorkerRequest(req: W2G): Promise<void> {
    switch (req.type) {
      case 'discord.send': {
        const { reqId, channelId, content } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased() || !('send' in channel)) {
            this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: `channel ${channelId} not sendable` });
            return;
          }
          const payload = content.length === 0 ? ' ' : content;
          const sent = await (channel as { send: (c: string) => Promise<Message> }).send(payload);
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: { messageId: sent.id } });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.send.file': {
        const { reqId, channelId, filePath, caption } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased() || !('send' in channel)) {
            this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: `channel ${channelId} not sendable` });
            return;
          }
          const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });
          await (channel as { send: (o: object) => Promise<Message> }).send({ content: caption ?? '', files: [attachment] });
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.send.url': {
        const { reqId, channelId, url, caption } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased() || !('send' in channel)) {
            this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: `channel ${channelId} not sendable` });
            return;
          }
          const content = caption ? `${caption}\n${url}` : url;
          await (channel as { send: (c: string) => Promise<Message> }).send(content);
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.send.components': {
        const { reqId, channelId, content, components } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased() || !('send' in channel)) {
            this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: `channel ${channelId} not sendable` });
            return;
          }
          // components are plain Discord API JSON objects — discord.js accepts them directly
          const sent = await (channel as { send: (o: object) => Promise<Message> }).send({ content, components });
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: { messageId: sent.id } });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.thread.create': {
        const { reqId, channelId, msgId, name } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !channel.isTextBased() || !('messages' in channel)) {
            this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: `channel ${channelId} not found` });
            return;
          }
          const msg = await (channel as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(msgId);
          const thread = await msg.startThread({
            name: truncate(name, THREAD_NAME_MAX),
            autoArchiveDuration: DEFAULT_AUTO_ARCHIVE_MIN,
          });
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: { threadId: thread.id } });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.thread.delete': {
        const { reqId, channelId } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (channel && 'delete' in channel && typeof (channel as { delete?: unknown }).delete === 'function') {
            await (channel as { delete: () => Promise<unknown> }).delete();
          }
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.message.delete': {
        const { channelId, msgId } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (channel && 'messages' in channel) {
            const msg = await (channel as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(msgId);
            await msg.delete();
          }
        } catch (err) {
          log.error({ err: (err as Error).message, channelId, msgId }, 'discord.message.delete failed');
        }
        return;
      }

      case 'discord.typing.start': {
        const { channelId } = req;
        // Stop any existing typing loop for this channel
        const existing = this.typingLoops.get(channelId);
        if (existing) existing();

        let cancelled = false;
        let timer: NodeJS.Timeout | null = null;

        const fire = (): void => {
          if (cancelled) return;
          void this.client.channels.fetch(channelId).then((ch) => {
            if (cancelled || !ch || !('sendTyping' in ch)) return;
            return (ch as { sendTyping: () => Promise<void> }).sendTyping();
          }).catch((err) => {
            log.debug({ err: (err as Error).message }, 'sendTyping failed');
          });
          if (cancelled) return;
          timer = setTimeout(fire, TYPING_REFRESH_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
        };

        const cleanup = (): void => {
          cancelled = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          this.typingLoops.delete(channelId);
        };

        this.typingLoops.set(channelId, cleanup);
        fire();
        return;
      }

      case 'discord.typing.stop': {
        const { channelId } = req;
        const cleanup = this.typingLoops.get(channelId);
        if (cleanup) cleanup();
        return;
      }

      case 'discord.fetch.message': {
        const { reqId, channelId, msgId } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !('messages' in channel)) {
            this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: null });
            return;
          }
          const msg = await (channel as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(msgId);
          const serialized: SerializedMessage = {
            id: msg.id,
            content: msg.content,
            authorId: msg.author.id,
            authorName: msg.author.username,
            authorIsBot: msg.author.bot,
            attachments: Array.from(msg.attachments.values()).map((a) => ({
              name: a.name ?? 'attachment',
              url: a.url,
            })),
            createdAt: msg.createdAt.toISOString(),
          };
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: serialized });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.fetch.messages': {
        const { reqId, channelId, limit, before } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !('messages' in channel)) {
            this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: [] });
            return;
          }
          const opts: { limit: number; before?: string; cache: boolean } = { limit, cache: false };
          if (before) opts.before = before;
          const fetched = await (channel as { messages: { fetch: (o: object) => Promise<Map<string, Message>> } }).messages.fetch(opts);
          const serialized: SerializedMessage[] = [...fetched.values()].map((msg) => ({
            id: msg.id,
            content: msg.content,
            authorId: msg.author.id,
            authorName: msg.author.username,
            authorIsBot: msg.author.bot,
            attachments: Array.from(msg.attachments.values()).map((a) => ({
              name: a.name ?? 'attachment',
              url: a.url,
            })),
            createdAt: msg.createdAt.toISOString(),
          }));
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: serialized });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.fetch.starter': {
        const { reqId, channelId } = req;
        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel || !channel.isThread()) {
            this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: null });
            return;
          }
          const starter = await channel.fetchStarterMessage({ cache: false });
          if (!starter) {
            this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: null });
            return;
          }
          const serialized: SerializedMessage = {
            id: starter.id,
            content: starter.content,
            authorId: starter.author.id,
            authorName: starter.author.username,
            authorIsBot: starter.author.bot,
            attachments: Array.from(starter.attachments.values()).map((a) => ({
              name: a.name ?? 'attachment',
              url: a.url,
            })),
            createdAt: starter.createdAt.toISOString(),
          };
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId, data: serialized });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      case 'discord.interaction.reply': {
        const { reqId, interactionId, token, content, ephemeral } = req;
        try {
          await this.client.rest.post(Routes.interactionCallback(interactionId, token), {
            body: {
              type: 4,
              data: {
                content,
                flags: ephemeral ? 64 : 0,
              },
            },
          });
          this.ipc.sendToWorker({ type: 'ipc.ok', reqId });
        } catch (err) {
          this.ipc.sendToWorker({ type: 'ipc.err', reqId, error: (err as Error).message });
        }
        return;
      }

      default:
        // worker.ready and worker.drain are handled by GatewayIpc internally
        break;
    }
  }

  // -------------------------------------------------------------------------
  // processMessageQueue — replay queued messages after worker restart
  // -------------------------------------------------------------------------

  private async processMessageQueue(): Promise<void> {
    const pending = getPendingMessages(this.db);
    if (pending.length === 0) return;

    log.info({ count: pending.length }, 'replaying queued messages after restart');

    for (const queued of pending) {
      deleteQueuedMessage(this.db, queued.id);
      try {
        const channel = await this.client.channels.fetch(queued.channelId);
        if (!channel || !('messages' in channel)) {
          log.warn({ channelId: queued.channelId }, 'queued message: channel not found');
          continue;
        }
        const msg = await (channel as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(queued.messageId);
        log.info({ channelId: queued.channelId, messageId: queued.messageId }, 'replaying queued message');
        const ctx = this.buildContext(msg);
        const isThread = msg.channel.isThread();
        const threadKey = isThread ? msg.channel.id : msg.channelId;
        this.ipc.forwardEvent({
          type: 'discord.message',
          ctx,
          threadKey,
          msgId: msg.id,
          channelId: msg.channelId,
        });
      } catch (err) {
        log.error(
          { err: (err as Error).message, channelId: queued.channelId, messageId: queued.messageId },
          'queued message: replay failed',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // triggerWikiScan — Gateway-side wiki source scan (survives Worker restart)
  // -------------------------------------------------------------------------

  async triggerWikiScan(): Promise<void> {
    if (this.wikiScanTask) {
      log.warn('wiki-scan: already in progress, skipping duplicate trigger');
      return;
    }
    this.wikiScanTask = this._doWikiScan();
    try {
      await this.wikiScanTask;
    } finally {
      this.wikiScanTask = null;
    }
  }

  private async _doWikiScan(): Promise<void> {
    const channelId = this.config.wikiChannelId;
    if (!channelId) return;

    const sourcesPath = path.join(this.config.simpleclawRepoPath, 'data', 'wiki-sources.json');
    const today = new Date().toLocaleDateString('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    // Post initial message and create thread
    let thread: { id: string; send: (c: string) => Promise<unknown> };
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        log.error({ channelId }, 'wiki-scan: channel not found or not text-based');
        return;
      }
      const msg = await (channel as { send: (c: string) => Promise<Message> }).send(
        `📡 **wiki 소스 스캔** — ${today}`,
      );
      thread = await msg.startThread({
        name: truncate(`wiki-scan: ${today}`, THREAD_NAME_MAX),
        autoArchiveDuration: DEFAULT_AUTO_ARCHIVE_MIN,
      }) as typeof thread;
    } catch (err) {
      log.error({ err: (err as Error).message }, 'wiki-scan: failed to create thread');
      return;
    }

    const threadId = thread.id;
    const systemAppend = buildWikiScanSystemAppend(sourcesPath);
    const prompt = '등록된 wiki 소스들에서 오늘의 신규 지식 후보를 탐색하고 보고해줘.';

    log.info({ threadId }, 'wiki-scan: thread created, invoking Claude');
    const stopTyping = this.startGatewayTyping(threadId);
    try {
      logEvent(this.db, {
        type: 'claude.invoke',
        channel: 'wiki-scan',
        threadId,
        summary: 'wiki-scan daily',
        meta: { sourcesPath },
      });

      let result;
      try {
        result = await runClaude({
          cwd: this.config.paths.dataDir,
          prompt,
          systemAppend,
          timeoutMs: 10 * 60 * 1000,
        });
      } catch (err) {
        const e = err instanceof ClaudeError ? err : (err as Error);
        log.error({ err: e.message }, 'wiki-scan: claude run failed');
        await thread.send(`❌ wiki 스캔 실패: ${e.message.slice(0, 1500)}`);
        return;
      }

      log.info({ threadId, durationMs: result.durationMs, textLen: result.text.length }, 'wiki-scan: Claude completed, posting results');

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
        await thread.send(chunk);
      }

      logEvent(this.db, {
        type: 'claude.result',
        channel: 'wiki-scan',
        threadId,
        summary: `${result.durationMs}ms ${result.text.length}chars`,
        meta: { duration_seconds: result.durationMs / 1000 },
      });
    } finally {
      stopTyping();
    }
  }

  private startGatewayTyping(channelId: string): () => void {
    const existing = this.typingLoops.get(channelId);
    if (existing) existing();

    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;

    const fire = (): void => {
      if (cancelled) return;
      void this.client.channels.fetch(channelId).then((ch) => {
        if (cancelled || !ch || !('sendTyping' in ch)) return;
        return (ch as { sendTyping: () => Promise<void> }).sendTyping();
      }).catch(() => {});
      if (cancelled) return;
      timer = setTimeout(fire, TYPING_REFRESH_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };

    const cleanup = (): void => {
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      this.typingLoops.delete(channelId);
    };

    this.typingLoops.set(channelId, cleanup);
    fire();
    return cleanup;
  }

  // postToChannel — simple one-shot message (used by repo-sync / dreaming)
  // -------------------------------------------------------------------------

  async postToChannel(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`postToChannel: channel ${channelId} not found or not text-based`);
    }
    const payload = content.length === 0 ? ' ' : content;
    await (channel as { send: (c: string) => Promise<Message> }).send(payload);
  }

  // -------------------------------------------------------------------------
  // postMailAlert (MailAlertPoster)
  // -------------------------------------------------------------------------

  async postMailAlert(args: {
    channelId: string;
    threadName: string;
    initialMessage: string;
    threadFirstMessage?: string;
    attachmentFiles?: { path: string; filename: string }[];
    senderEmail?: string;
    senderAccount?: string;
  }): Promise<{ threadId: string; firstMessageId: string }> {
    if (!args || typeof args.channelId !== 'string' || args.channelId.length === 0) {
      throw new Error('postMailAlert: channelId required');
    }
    if (typeof args.threadName !== 'string' || args.threadName.length === 0) {
      throw new Error('postMailAlert: threadName required');
    }
    if (typeof args.initialMessage !== 'string') {
      throw new Error('postMailAlert: initialMessage required');
    }

    const channel = await this.client.channels.fetch(args.channelId);
    if (!channel) {
      throw new Error(`postMailAlert: channel ${args.channelId} not found`);
    }
    if (!channel.isTextBased() || !('send' in channel) || typeof (channel as { send?: unknown }).send !== 'function') {
      throw new Error(`postMailAlert: channel ${args.channelId} is not text-sendable`);
    }
    const sendable = channel as unknown as TextSendable;

    const chunks = splitMessage(args.initialMessage, SAFE_CHUNK_SIZE);

    // Build "이 발신자 무시" button if sender info provided (plain API JSON)
    let components: object[] = [];
    if (args.senderEmail && args.senderAccount) {
      components = [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 2,
              label: '이 발신자 무시',
              custom_id: buildIgnoreSenderButtonId(args.senderEmail, args.senderAccount),
            },
          ],
        },
      ];
    }

    const firstMsg = await sendable.send({
      content: chunks[0] ?? '',
      components,
    });

    const truncatedName = truncate(args.threadName, THREAD_NAME_MAX);
    const thread = await firstMsg.startThread({
      name: truncatedName,
      autoArchiveDuration: DEFAULT_AUTO_ARCHIVE_MIN,
    });

    for (const chunk of chunks.slice(1)) {
      try {
        await thread.send(chunk);
      } catch (err) {
        log.error(
          { err: (err as Error).message, threadId: thread.id },
          'postMailAlert: failed to send follow-up chunk',
        );
      }
    }

    if (args.threadFirstMessage) {
      const bodyChunks = splitMessage(args.threadFirstMessage, SAFE_CHUNK_SIZE);
      for (const chunk of bodyChunks) {
        try {
          await thread.send(chunk);
        } catch (err) {
          log.error(
            { err: (err as Error).message, threadId: thread.id },
            'postMailAlert: failed to send mail body chunk',
          );
        }
      }
    }

    for (const file of args.attachmentFiles ?? []) {
      try {
        const attachment = new AttachmentBuilder(file.path, { name: file.filename });
        await thread.send({ files: [attachment] });
      } catch (err) {
        log.error(
          { err: (err as Error).message, filename: file.filename, threadId: thread.id },
          'postMailAlert: failed to upload attachment',
        );
      }
    }

    return { threadId: thread.id, firstMessageId: firstMsg.id };
  }

  // -------------------------------------------------------------------------
  // sendFile — attach a local file to a channel or thread
  // -------------------------------------------------------------------------

  async sendFile(args: {
    channelId: string;
    threadId: string | null;
    filePath: string;
    caption?: string;
  }): Promise<void> {
    const targetId = args.threadId ?? args.channelId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`sendFile: channel/thread ${targetId} not found or not text-based`);
    }
    const attachment = new AttachmentBuilder(args.filePath, {
      name: path.basename(args.filePath),
    });
    const sendable = channel as unknown as TextSendable;
    await sendable.send({
      content: args.caption ?? '',
      files: [attachment],
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TextSendable {
  send(content: string): Promise<Message>;
  send(options: object): Promise<Message>;
  id: string;
}

function stripLeadingMention(text: string, botUserId: string): string {
  if (!text) return '';
  if (!botUserId) return text.trim();
  const re = new RegExp(`^(?:<@!?${botUserId}>\\s*)+`);
  return text.replace(re, '').trim();
}

const IGNORE_SENDER_PREFIX = 'ignore-sender';

function buildIgnoreSenderButtonId(email: string, account: string): string {
  return `${IGNORE_SENDER_PREFIX}:${email}:${account}`;
}

// Re-export makeThreadTitle for convenience (not actually used here but keeping consistent)
export { makeThreadTitle };
