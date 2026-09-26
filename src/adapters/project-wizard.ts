/**
 * New-project wizard (gateway-side).
 *
 * UX: #claw 채널에 고정된 [🆕 새 프로젝트] 버튼 → Modal(scope / 이름 / 공개여부 / 감시옵션 / 설명)
 *   → 계획 카드 [✅ 진행] [취소] → 단계별 실행(GitHub repo → clone → 채널 → config 등록) → 완료.
 *
 * Runs entirely in the gateway: a Modal must be the *immediate* interaction response (3s),
 * so it can't round-trip through the worker. Every step is idempotent — existing repos,
 * clones and channels are detected and reused, so re-running after a partial failure resumes.
 * Nothing is ever deleted on failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  LabelBuilder,
  MessageType,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';

import type { AppConfig, RepoEntry } from '../config.js';
import type { GatewayIpc } from '../ipc/server.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';

const execFileAsync = promisify(execFile);

export const PROJECT_ID_PREFIX = 'project:';
const ID_NEW = 'project:new';
const ID_MODAL = 'project:modal';
const ID_GO = 'project:go:';
const ID_CANCEL = 'project:cancel:';
const F_SCOPE = 'scope';
const F_NAME = 'name';
const F_VISIBILITY = 'visibility';
const F_WATCH = 'watch';
const F_DESC = 'description';

const PLAN_TTL_MS = 30 * 60_000;
const LAUNCHER_STATE_FILE = 'project-launcher.json';
/** Sticky launcher: repost after this much channel silence, if not among the last N messages. */
const STICKY_IDLE_MS = 5 * 60_000;
const STICKY_WINDOW = 10;

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** GitHub repo name rule: letters, digits, `.`, `-`, `_`; not `.`/`..`. */
export function validateRepoName(name: string): string | null {
  if (!name) return 'repo 이름이 비어 있습니다.';
  if (name.length > 100) return 'repo 이름은 100자 이하여야 합니다.';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'repo 이름은 영문·숫자·`.`·`-`·`_`만 쓸 수 있습니다.';
  if (name === '.' || name === '..') return '`.`/`..`은 repo 이름으로 쓸 수 없습니다.';
  return null;
}

/** Discord text channel names are lowercase; `.` isn't allowed. */
export function toChannelName(repoName: string): string {
  return repoName.toLowerCase().replace(/\./g, '-').slice(0, 100);
}

export function buildLocalPath(reposDir: string, scope: string, name: string): string {
  return path.join(reposDir, scope, name);
}

/** True if a git remote URL points at `fullName` (https or ssh, case-insensitive). */
export function remoteMatches(remoteUrl: string, fullName: string): boolean {
  const normalized = remoteUrl
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(?:[^@/]+@)?github\.com\//, '');
  return normalized.toLowerCase() === fullName.toLowerCase();
}

/** Append a repo entry to simpleclaw.config.json (atomic write). No-op if channelId already bound. */
export function appendRepoToConfigFile(configPath: string, entry: RepoEntry): boolean {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { repos: RepoEntry[] };
  if (raw.repos.some((r) => r.channelId === entry.channelId)) return false;
  raw.repos.push(entry);
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, configPath);
  return true;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProjectPlan {
  id: string;
  scope: string;
  name: string;
  fullName: string;
  visibility: 'private' | 'public';
  description: string;
  watchIssues: boolean;
  watchPrs: boolean;
  localPath: string;
  channelName: string;
  /** Detected state at plan time */
  repoExists: boolean;
  localExists: boolean;
  existingChannelId: string | undefined;
  createdAt: number;
}

type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
interface Step {
  label: string;
  status: StepStatus;
  note?: string;
}

const STEP_ICON: Record<StepStatus, string> = {
  pending: '⬜',
  running: '🔄',
  done: '✅',
  skipped: '⏭️',
  failed: '❌',
};

export function renderPlan(p: ProjectPlan): string {
  const repoLine = p.repoExists
    ? `\`${p.fullName}\` (이미 존재 — 연결만)`
    : `\`${p.fullName}\` (${p.visibility}, 신규 생성)`;
  const localLine = p.localExists ? `\`${p.localPath}\` (이미 존재)` : `\`${p.localPath}\``;
  const channelLine = p.existingChannelId
    ? `<#${p.existingChannelId}> (이미 존재 — 재사용)`
    : `#${p.channelName} (신규 생성)`;
  const watch = [p.watchIssues && '이슈', p.watchPrs && 'PR'].filter(Boolean).join('·') || '없음';
  return [
    '📋 **새 프로젝트 계획**',
    `• Repo: ${repoLine}`,
    `• 로컬: ${localLine}`,
    `• 채널: ${channelLine}`,
    `• 감시: ${watch}`,
    p.description ? `• 설명: ${p.description}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderSteps(p: ProjectPlan, steps: Step[], footer?: string): string {
  const lines = [`🛠️ **${p.fullName}** 생성 중`];
  for (const s of steps) lines.push(`${STEP_ICON[s.status]} ${s.label}${s.note ? ` — ${s.note}` : ''}`);
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

// ── Wizard ──────────────────────────────────────────────────────────────────

interface ProjectWizardOpts {
  client: Client;
  config: AppConfig;
  db: Database.Database;
  ipc: GatewayIpc;
}

export class ProjectWizard {
  private readonly client: Client;
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly ipc: GatewayIpc;
  private readonly plans = new Map<string, ProjectPlan>();
  /** Plans currently executing — blocks double-clicks on ✅ 진행. */
  private readonly running = new Set<string>();
  private launcherMessageId: string | undefined;
  private stickyTimer: NodeJS.Timeout | undefined;

  constructor(opts: ProjectWizardOpts) {
    this.client = opts.client;
    this.config = opts.config;
    this.db = opts.db;
    this.ipc = opts.ipc;
  }

  private get launcherChannelId(): string {
    return this.config.simpleclawChannelId ?? this.config.generalChannelId;
  }

  private isOwner(userId: string): boolean {
    return userId === this.config.env.DISCORD_OWNER_USER_ID;
  }

  /** Ensure the [🆕 새 프로젝트] launcher message exists in the simpleclaw channel. */
  async ensureLauncher(): Promise<void> {
    const channel = await this.fetchLauncherChannel();
    if (!channel) return;

    try {
      const state = JSON.parse(fs.readFileSync(this.launcherStateFile, 'utf-8')) as {
        channelId: string;
        messageId: string;
      };
      if (state.channelId === channel.id) {
        await channel.messages.fetch(state.messageId);
        this.launcherMessageId = state.messageId;
        return; // still there
      }
    } catch {
      /* missing state or deleted message → (re)post */
    }

    await this.postLauncher(channel);
  }

  /**
   * Sticky launcher: pins don't keep a message at the bottom of the chat, so once the channel
   * has been idle for STICKY_IDLE_MS and the launcher has scrolled out of the last
   * STICKY_WINDOW messages, repost it at the bottom and delete the old one.
   * Call for every MessageCreate (any author) — non-launcher channels are ignored.
   */
  onChannelMessage(msg: Message): void {
    if (msg.channelId !== this.launcherChannelId || msg.id === this.launcherMessageId) return;
    // "SimpleClaw pinned a message" notice for our own launcher — pure noise on every repost.
    if (
      msg.type === MessageType.ChannelPinnedMessage &&
      msg.author.id === this.client.user?.id &&
      msg.reference?.messageId === this.launcherMessageId
    ) {
      void msg.delete().catch(() => undefined);
      return;
    }
    if (this.stickyTimer) clearTimeout(this.stickyTimer);
    this.stickyTimer = setTimeout(() => {
      this.stickyTimer = undefined;
      void this.bumpLauncher().catch((err: Error) => {
        log.warn({ err: err.message }, 'project-wizard: launcher bump failed');
      });
    }, STICKY_IDLE_MS);
    this.stickyTimer.unref();
  }

  dispose(): void {
    if (this.stickyTimer) clearTimeout(this.stickyTimer);
    this.stickyTimer = undefined;
  }

  private async bumpLauncher(): Promise<void> {
    const channel = await this.fetchLauncherChannel();
    if (!channel) return;
    const recent = await channel.messages.fetch({ limit: STICKY_WINDOW });
    if (this.launcherMessageId && recent.has(this.launcherMessageId)) return; // still visible
    const oldId = this.launcherMessageId;
    // Post first, then delete — the launcher is never absent.
    await this.postLauncher(channel);
    if (oldId) await channel.messages.delete(oldId).catch(() => undefined);
  }

  private get launcherStateFile(): string {
    return path.join(this.config.paths.dataDir, LAUNCHER_STATE_FILE);
  }

  private async fetchLauncherChannel(): Promise<GuildTextBasedChannel | null> {
    const channel = await this.client.channels.fetch(this.launcherChannelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      log.warn({ channelId: this.launcherChannelId }, 'project-wizard: launcher channel not sendable');
      return null;
    }
    return channel;
  }

  private async postLauncher(channel: GuildTextBasedChannel): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ID_NEW).setLabel('새 프로젝트').setEmoji('🆕').setStyle(ButtonStyle.Primary),
    );
    const msg = await channel.send({
      content: '**프로젝트 생성** — GitHub repo 생성·clone, Discord 채널 생성, SimpleClaw 연결을 한 번에 합니다.',
      components: [row],
    });
    this.launcherMessageId = msg.id;
    fs.writeFileSync(this.launcherStateFile, JSON.stringify({ channelId: channel.id, messageId: msg.id }) + '\n');
    await msg.pin().catch((err: Error) => {
      log.info({ err: err.message }, 'project-wizard: launcher pin failed (needs Pin Messages permission)');
    });
    log.info({ messageId: msg.id }, 'project-wizard: launcher posted');
  }

  // ── Interaction entry points ──────────────────────────────────────────────

  async onButton(interaction: ButtonInteraction): Promise<void> {
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '프로젝트 생성은 owner만 할 수 있습니다.', ephemeral: true });
      return;
    }
    const id = interaction.customId;
    if (id === ID_NEW) {
      await interaction.showModal(this.buildModal());
      return;
    }
    if (id.startsWith(ID_CANCEL)) {
      this.plans.delete(id.slice(ID_CANCEL.length));
      await interaction.update({ content: '🚫 프로젝트 생성을 취소했습니다.', components: [] });
      return;
    }
    if (id.startsWith(ID_GO)) {
      await this.onConfirm(interaction, id.slice(ID_GO.length));
    }
  }

  async onModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId !== ID_MODAL) return;
    if (!this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: '프로젝트 생성은 owner만 할 수 있습니다.', ephemeral: true });
      return;
    }

    const f = interaction.fields;
    const scope = f.getStringSelectValues(F_SCOPE)[0] ?? '';
    const name = f.getTextInputValue(F_NAME).trim();
    const visibility = f.getStringSelectValues(F_VISIBILITY)[0] === 'public' ? 'public' : 'private';
    const watch = f.getStringSelectValues(F_WATCH);
    const description = f.getTextInputValue(F_DESC).trim().replace(/\s+/g, ' ');

    const nameErr = validateRepoName(name);
    if (nameErr || !this.config.projectWizard.githubScopes.includes(scope)) {
      await interaction.reply({ content: `⚠️ ${nameErr ?? `알 수 없는 scope: ${scope}`}`, ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const fullName = `${scope}/${name}`;
    const localPath = buildLocalPath(this.config.projectWizard.reposDir, scope, name);
    const channelName = toChannelName(name);
    const guild = await this.getGuild();
    const [repoExists, existingChannel] = await Promise.all([
      this.githubRepoExists(fullName),
      this.findTextChannel(guild, channelName),
    ]);

    const plan: ProjectPlan = {
      id: crypto.randomBytes(6).toString('hex'),
      scope,
      name,
      fullName,
      visibility,
      description,
      watchIssues: watch.includes('issues'),
      watchPrs: watch.includes('prs'),
      localPath,
      channelName,
      repoExists,
      localExists: fs.existsSync(localPath),
      existingChannelId: existingChannel?.id,
      createdAt: Date.now(),
    };

    const bound = existingChannel && this.config.repoChannels.find((r) => r.channelId === existingChannel.id);
    if (bound) {
      await interaction.editReply(
        `⚠️ <#${existingChannel.id}> 채널은 이미 \`${bound.fullName}\`에 연결되어 있습니다. 다른 이름을 써주세요.`,
      );
      return;
    }

    this.prunePlans();
    this.plans.set(plan.id, plan);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${ID_GO}${plan.id}`).setLabel('진행').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${ID_CANCEL}${plan.id}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({ content: renderPlan(plan), components: [row] });
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  private async onConfirm(interaction: ButtonInteraction, planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) {
      await interaction.update({
        content: '⌛ 계획이 만료되었습니다(30분 경과 또는 재시작). 🆕 버튼으로 다시 시작해주세요.',
        components: [],
      });
      return;
    }
    if (this.running.has(planId)) {
      await interaction.deferUpdate();
      return;
    }
    this.running.add(planId);

    const steps: Step[] = [
      { label: 'GitHub repo', status: 'pending' },
      { label: 'clone', status: 'pending' },
      { label: 'Discord 채널', status: 'pending' },
      { label: 'SimpleClaw 연결', status: 'pending' },
    ];
    await interaction.update({ content: renderSteps(plan, steps), components: [] });
    const message = interaction.message;
    const refresh = (footer?: string) =>
      message.edit({ content: renderSteps(plan, steps, footer), components: [] }).catch(() => undefined);

    const run = async (i: number, fn: () => Promise<string | undefined | false>): Promise<void> => {
      steps[i].status = 'running';
      await refresh();
      const result = await fn();
      if (result === false) {
        steps[i].status = 'skipped';
      } else {
        steps[i].status = 'done';
        if (result) steps[i].note = result;
      }
    };

    let channelId = '';
    try {
      await run(0, async () => {
        if (await this.githubRepoExists(plan.fullName)) return false;
        const args = ['repo', 'create', plan.fullName, `--${plan.visibility}`, '--add-readme'];
        if (plan.description) args.push('--description', plan.description);
        await execFileAsync('gh', args, { env: process.env });
        return plan.visibility;
      });

      await run(1, async () => {
        if (fs.existsSync(plan.localPath)) {
          const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: plan.localPath });
          if (!remoteMatches(stdout, plan.fullName)) {
            throw new Error(`${plan.localPath}가 이미 있지만 origin이 ${stdout.trim()}입니다`);
          }
          return false;
        }
        fs.mkdirSync(path.dirname(plan.localPath), { recursive: true });
        await execFileAsync('gh', ['repo', 'clone', plan.fullName, plan.localPath], { env: process.env });
        return plan.localPath;
      });

      await run(2, async () => {
        const guild = await this.getGuild();
        const existing = await this.findTextChannel(guild, plan.channelName);
        if (existing) {
          channelId = existing.id;
          return false;
        }
        const created = await guild.channels.create({
          name: plan.channelName,
          type: ChannelType.GuildText,
          parent: await this.resolveCategoryId(guild),
          topic: `${plan.fullName}${plan.description ? ` — ${plan.description}` : ''}`,
        });
        channelId = created.id;
        return undefined;
      });

      await run(3, async () => {
        const entry: RepoEntry = {
          channelName: plan.channelName,
          channelId,
          fullName: plan.fullName,
          localPath: plan.localPath,
          category: 'code',
          description: plan.description,
          ...(plan.watchIssues ? { watchIssues: true } : {}),
          ...(plan.watchPrs ? { watchPrs: true } : {}),
        };
        appendRepoToConfigFile(this.config.configFilePath, entry);
        // Hot-reload: gateway and worker both hold config.repoChannels by reference.
        if (!this.config.repoChannels.some((r) => r.channelId === channelId)) {
          this.config.repoChannels.push(entry);
        }
        this.ipc.forwardEvent({ type: 'config.repo.added', repo: entry });
        return undefined;
      });

      await this.postWelcome(channelId, plan);
      await refresh(`🎉 완료 — <#${channelId}> 에서 바로 작업을 시작하세요.`);
      this.plans.delete(planId);
      logEvent(this.db, {
        type: 'project.create',
        channel: 'simpleclaw',
        summary: `${plan.fullName} → #${plan.channelName}`,
        meta: { fullName: plan.fullName, channelId, localPath: plan.localPath, repoExisted: plan.repoExists },
      });
    } catch (err) {
      const current = steps.find((s) => s.status === 'running');
      const msg = (err as Error & { stderr?: string }).stderr?.trim() || (err as Error).message;
      if (current) {
        current.status = 'failed';
        current.note = hint(msg);
      }
      log.error({ err: msg, plan: plan.fullName }, 'project-wizard: step failed');
      logEvent(this.db, {
        type: 'project.create.failed',
        channel: 'simpleclaw',
        summary: `${plan.fullName}: ${current?.label ?? '?'} 실패`,
        meta: { fullName: plan.fullName, error: msg.slice(0, 500) },
      });
      // Keep the plan so a retry resumes from the failed step (all steps are idempotent).
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${ID_GO}${plan.id}`).setLabel('다시 시도').setEmoji('🔁').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${ID_CANCEL}${plan.id}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
      );
      await message
        .edit({
          content: renderSteps(plan, steps, '중단했습니다. 이미 만든 것은 그대로 두었고, 다시 시도하면 이어서 진행합니다.'),
          components: [row],
        })
        .catch(() => undefined);
    } finally {
      this.running.delete(planId);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private buildModal(): ModalBuilder {
    const scopes = this.config.projectWizard.githubScopes;
    return new ModalBuilder()
      .setCustomId(ID_MODAL)
      .setTitle('새 프로젝트')
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('GitHub scope')
          .setDescription('로컬 경로: repos/{scope}/{이름}')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId(F_SCOPE)
              .addOptions(scopes.map((s, i) => ({ label: s, value: s, default: i === 0 }))),
          ),
        new LabelBuilder()
          .setLabel('Repo 이름')
          .setDescription('채널명은 이 이름(소문자)으로 만들어집니다')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(F_NAME)
              .setStyle(TextInputStyle.Short)
              .setMaxLength(100)
              .setRequired(true),
          ),
        new LabelBuilder().setLabel('공개 여부').setStringSelectMenuComponent(
          new StringSelectMenuBuilder().setCustomId(F_VISIBILITY).addOptions(
            { label: 'private', value: 'private', default: true },
            { label: 'public', value: 'public' },
          ),
        ),
        new LabelBuilder()
          .setLabel('감시 옵션')
          .setDescription('새 이슈·PR을 채널에 알림')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId(F_WATCH)
              .setRequired(false)
              .setMinValues(0)
              .setMaxValues(2)
              .addOptions({ label: '이슈 감시', value: 'issues' }, { label: 'PR 감시', value: 'prs' }),
          ),
        new LabelBuilder()
          .setLabel('설명')
          .setDescription('GitHub description·라우팅 힌트로 쓰입니다')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(F_DESC)
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(300)
              .setRequired(false),
          ),
      );
  }

  private async getGuild(): Promise<Guild> {
    return this.client.guilds.fetch(this.config.env.DISCORD_GUILD_ID);
  }

  private async findTextChannel(guild: Guild, name: string) {
    const channels = await guild.channels.fetch();
    return channels.find((c) => c?.type === ChannelType.GuildText && c.name === name) ?? undefined;
  }

  private async resolveCategoryId(guild: Guild): Promise<string | undefined> {
    if (this.config.projectWizard.channelCategoryId) return this.config.projectWizard.channelCategoryId;
    const general = await guild.channels.fetch(this.config.generalChannelId).catch(() => null);
    return general?.parentId ?? undefined;
  }

  private async githubRepoExists(fullName: string): Promise<boolean> {
    try {
      await execFileAsync('gh', ['repo', 'view', fullName, '--json', 'name'], { env: process.env });
      return true;
    } catch {
      return false;
    }
  }

  private async postWelcome(channelId: string, plan: ProjectPlan): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) return;
      await (channel as { send: (c: string) => Promise<Message> }).send(
        [
          `🔗 이 채널은 **${plan.fullName}**에 연결되어 있습니다.`,
          `로컬: \`${plan.localPath}\``,
          '여기에 메시지를 보내면 이 repo에서 작업합니다.',
        ].join('\n'),
      );
    } catch (err) {
      log.warn({ err: (err as Error).message, channelId }, 'project-wizard: welcome message failed');
    }
  }

  private prunePlans(): void {
    const now = Date.now();
    for (const [id, p] of this.plans) {
      if (now - p.createdAt > PLAN_TTL_MS) this.plans.delete(id);
    }
  }
}

/** Short, actionable hint for common failures. */
function hint(msg: string): string {
  if (/Missing Permissions|50013/.test(msg)) return '봇에 "채널 관리" 권한이 없습니다 (서버 설정 → 역할)';
  if (/already exists/i.test(msg)) return '이미 존재합니다 — 다시 시도하면 재사용합니다';
  return msg.split('\n')[0].slice(0, 200);
}
