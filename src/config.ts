import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { log } from './log.js';

const Schema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
  GH_TOKEN: z.string().min(1),

  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_PUBLIC_KEY: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_CHANNEL_GENERAL: z.string().min(1),
  /** Optional — if absent, simpleclaw-maintenance messages route through the general channel */
  DISCORD_CHANNEL_SIMPLECLAW: z.string().optional(),
  /** @deprecated Backwards compat alias for DISCORD_CHANNEL_SIMPLECLAW. Used when DISCORD_CHANNEL_SIMPLECLAW is absent. */
  DISCORD_CHANNEL_CLAW: z.string().optional(),
  /** Optional — if absent, mail alerts fall back to DISCORD_CHANNEL_GENERAL */
  DISCORD_CHANNEL_MAIL_ALERTS: z.string().optional(),
  /** Optional — wiki ingest channel (simpleclaw-wiki). If absent, wiki-ingest is disabled. */
  DISCORD_CHANNEL_WIKI: z.string().optional(),
  /** Optional — root channel. No repo binding; spawns Claude Code at $HOME with full access, owner-only. */
  DISCORD_CHANNEL_ROOT: z.string().optional(),
  /** Root directory for local clones — new projects clone into $REPOS_DIR/{scope}/{name}. */
  REPOS_DIR: z.string().default(path.resolve(os.homedir(), 'repos')),
  /** Absolute path to the LLM wiki directory. Defaults to ~/coding-agent-wiki */
  WIKI_DIR: z.string().default(path.resolve(os.homedir(), 'coding-agent-wiki')),
  DISCORD_OWNER_USER_ID: z.string().min(1),

  GMAIL_CLIENT_ID: z.string().optional().default(''),
  GMAIL_CLIENT_SECRET: z.string().optional().default(''),
  // GMAIL_REFRESH_TOKEN_1..N are read dynamically from process.env

  MAIL_POLL_INTERVAL_SEC: z.coerce.number().default(300),

  /** Set to true to enable iMessage polling (macOS only, requires Full Disk Access). */
  IMESSAGE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  IMESSAGE_POLL_INTERVAL_SEC: z.coerce.number().default(60),
  /** Optional — if absent, iMessage alerts fall back to DISCORD_CHANNEL_MAIL_ALERTS or DISCORD_CHANNEL_GENERAL */
  DISCORD_CHANNEL_IMESSAGE_ALERTS: z.string().optional(),

  DASHBOARD_PORT: z.coerce.number().default(3200),
  DASHBOARD_SECRET: z.string().min(8),

  DATA_DIR: z.string().default(path.resolve(process.cwd(), 'data')),
  LOGS_DIR: z.string().default(path.resolve(process.cwd(), 'logs')),

  /** vmc-bot token for VMC Daily Digest (optional) */
  VMC_BOT_TOKEN: z.string().optional(),
  /** VMC Discord channel ID to post daily digest (optional) */
  VMC_DIGEST_CHANNEL_ID: z.string().optional(),

  /** TypeSafe Jev API key — fast route 판정용 (optional). 없으면 fast route 비활성. */
  TYPESAFE_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof Schema>;

export type EngineName = 'claude-code' | 'codex' | 'tmux';

/**
 * Model a channel's Claude Code sessions run on. Stored as a CLI alias, not a full model id:
 * `claude --model opus` resolves to the current generation, so an alias never goes stale.
 */
export type ModelAlias = 'opus' | 'sonnet' | 'haiku';

const ModelAliasSchema = z.enum(['opus', 'sonnet', 'haiku']);

/**
 * The model to pass to `runClaude` for this repo's sessions — `undefined` means "whatever the CLI
 * is configured to use" (the default, and what every channel did before this existed).
 *
 * Returns `undefined` for non-claude engines: `CodexRunOptions.model` takes OpenAI model names, so
 * handing it 'opus' would fail the run, and tmux drives an interactive pane that has no such flag.
 */
export function resolveEngineModel(
  repo: Pick<RepoEntry, 'engine' | 'model'>,
): ModelAlias | undefined {
  if (repo.engine === 'codex' || repo.engine === 'tmux') return undefined;
  return repo.model;
}

export interface RepoEntry {
  channelName: string;
  channelId: string;
  fullName: string;
  localPath: string;
  category: 'personal' | 'code';
  description: string;
  engine?: EngineName;
  /** Model for this channel's sessions. Omit to use the CLI's configured model. claude-code only. */
  model?: ModelAlias;
  /** Poll for new GitHub issues and post alerts to this repo's Discord channel. */
  watchIssues?: boolean;
  /** Poll for new GitHub pull requests and post alerts to this repo's Discord channel. */
  watchPrs?: boolean;
  /** Automatically attempt to resolve simple issues via Claude Code (branch → PR). */
  autoSolveIssues?: boolean;
  /** Discord user IDs (besides the owner) allowed to send messages in this channel. */
  allowedUserIds?: string[];
  /** If true, this repo is the "hub" — messages sent to the general channel route here by default. */
  isHub?: boolean;
  /**
   * Confine this repo's engine sessions. Set it for a channel shared with someone other than the
   * owner: the engine otherwise runs with `--dangerously-skip-permissions` as the owner's macOS
   * user, so cwd is the only thing tying it to this repo.
   *
   * Sandboxed sessions also lose `claw-job` — `claw-job watch --check` stores a command that the
   * (unconfined) gateway later runs, which would hand the session a way straight out of the box.
   */
  sandbox?: {
    /** Seatbelt profile path. Must not be writable by the session it confines. */
    profile: string;
    /** HOME for the engine — transcripts and tool state land here, not in the owner's ~/.claude. */
    home: string;
    /** Env for the session, on top of the minimal base. The owner's `.env` is never inherited. */
    env?: Record<string, string>;
  };
}

export interface GmailAccount {
  email: string;
  refreshToken: string;
  label: string;
}

export interface AppConfig {
  env: Env;
  repoChannels: RepoEntry[];
  /** The hub repo — messages to the general channel route here by default (isHub: true). */
  hubRepo?: RepoEntry;
  generalChannelId: string;
  /** Channel where mail alerts are posted (DISCORD_CHANNEL_MAIL_ALERTS or fallback to general) */
  mailAlertChannelId: string;
  /** Undefined when DISCORD_CHANNEL_SIMPLECLAW is not set — simpleclaw-maintenance then routes via general channel */
  simpleclawChannelId: string | undefined;
  /** Channel for wiki ingest (simpleclaw-wiki). Undefined if DISCORD_CHANNEL_WIKI not set. */
  wikiChannelId: string | undefined;
  /**
   * Root channel — no repo binding, spawns Claude Code at $HOME with full access.
   * Gated to DISCORD_OWNER_USER_ID at the router level (never inferred from message text).
   * Undefined if DISCORD_CHANNEL_ROOT not set.
   */
  rootChannelId: string | undefined;
  /**
   * Model for the channels that have no repo entry to carry one. Each key omitted → CLI default.
   */
  channelModels: { root?: ModelAlias; simpleclaw?: ModelAlias; wiki?: ModelAlias };
  /** Absolute path to the LLM wiki directory */
  wikiDir: string;
  /** Absolute path to this SimpleClaw repository — derived from process.cwd() at startup */
  simpleclawRepoPath: string;
  /** vmc-bot token and target channel for VMC Daily Digest (optional) */
  vmcDigest: { botToken: string; channelId: string } | null;
  /** Whether to poll iMessage (IMESSAGE_ENABLED=true). macOS only. */
  imessageEnabled: boolean;
  /** Channel for iMessage alerts (DISCORD_CHANNEL_IMESSAGE_ALERTS → DISCORD_CHANNEL_MAIL_ALERTS → general) */
  imessageAlertChannelId: string;
  gmail: GmailAccount[];
  /** New-project wizard settings (🆕 button in the simpleclaw channel). */
  projectWizard: {
    /** GitHub owners (user/org) offered in the scope dropdown. Local path follows: reposDir/{scope}/{name}. */
    githubScopes: string[];
    reposDir: string;
    /** Discord category for newly created channels. Undefined → same category as the general channel. */
    channelCategoryId: string | undefined;
  };
  /** Absolute path of the simpleclaw.config.json that was loaded (the wizard appends repos to it). */
  configFilePath: string;
  paths: {
    dataDir: string;
    logsDir: string;
    dbFile: string;
  };
}

// ── simpleclaw.config.json schema ──────────────────────────────────────────────────

const RepoEntryConfigSchema = z.object({
  channelName: z.string().min(1),
  channelId: z.string().min(1),
  fullName: z.string().min(1),
  localPath: z.string().min(1),
  category: z.enum(['personal', 'code']),
  description: z.string().default(''),
  engine: z.enum(['claude-code', 'codex', 'tmux']).optional(),
  model: ModelAliasSchema.optional(),
  watchIssues: z.boolean().optional(),
  watchPrs: z.boolean().optional(),
  autoSolveIssues: z.boolean().optional(),
  allowedUserIds: z.array(z.string()).optional(),
  isHub: z.boolean().optional(),
  sandbox: z
    .object({
      profile: z.string().min(1),
      home: z.string().min(1),
      env: z.record(z.string()).optional(),
    })
    .optional(),
});

const GmailAccountConfigSchema = z.object({
  email: z.string().email(),
  label: z.string().min(1),
});

const SimpleClawConfigSchema = z.object({
  repos: z.array(RepoEntryConfigSchema).min(1),
  gmail: z.array(GmailAccountConfigSchema).default([]),
  /** GitHub scopes (user/org) offered by the new-project wizard. Defaults to owners of registered repos. */
  githubScopes: z.array(z.string().min(1)).max(25).optional(),
  /** Discord category ID for channels created by the new-project wizard. */
  projectChannelCategoryId: z.string().optional(),
  /** Model for the non-repo channels (root / simpleclaw-maintenance / wiki-ingest). */
  channelModels: z
    .object({
      root: ModelAliasSchema.optional(),
      simpleclaw: ModelAliasSchema.optional(),
      wiki: ModelAliasSchema.optional(),
    })
    .optional(),
});

function loadSimpleClawConfig(): { config: z.infer<typeof SimpleClawConfigSchema>; path: string } {
  const configPath = path.resolve(process.cwd(), 'simpleclaw.config.json');
  const legacyPath = path.resolve(process.cwd(), 'claw.config.json');

  let resolvedPath = configPath;
  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(legacyPath)) {
      log.warn(
        { legacyPath, configPath },
        'simpleclaw.config.json not found — falling back to legacy claw.config.json. Rename when convenient.',
      );
      resolvedPath = legacyPath;
    } else {
      throw new Error(
        `simpleclaw.config.json not found at ${configPath}.\n` +
          `Copy simpleclaw.config.example.json, fill in your repos and Gmail accounts, then restart.`,
      );
    }
  }
  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  return { config: SimpleClawConfigSchema.parse(raw), path: resolvedPath };
}

export function loadConfig(): AppConfig {
  const env = Schema.parse(process.env);
  const { config: simpleclawConfig, path: configFilePath } = loadSimpleClawConfig();

  const repoChannels: RepoEntry[] = simpleclawConfig.repos;

  // Refresh tokens are indexed: GMAIL_REFRESH_TOKEN_1 → gmail[0], _2 → gmail[1], …
  const gmail: GmailAccount[] = simpleclawConfig.gmail
    .map((account, i) => ({
      ...account,
      refreshToken: process.env[`GMAIL_REFRESH_TOKEN_${i + 1}`] ?? '',
    }))
    .filter((a) => a.refreshToken.length > 0);

  // A model set on a non-claude engine is silently dropped by resolveEngineModel — say so once,
  // at boot, rather than leaving the owner to wonder why the channel ignores it.
  for (const repo of repoChannels) {
    if (repo.model && (repo.engine === 'codex' || repo.engine === 'tmux')) {
      log.warn(
        { channel: repo.channelName, engine: repo.engine, model: repo.model },
        'model is ignored for this channel — only the claude-code engine takes a model alias',
      );
    }
  }

  const hubRepo = repoChannels.find((r) => r.isHub);

  // Backwards compat: prefer DISCORD_CHANNEL_SIMPLECLAW, fall back to legacy DISCORD_CHANNEL_CLAW.
  const simpleclawChannelId = env.DISCORD_CHANNEL_SIMPLECLAW ?? env.DISCORD_CHANNEL_CLAW;
  if (!env.DISCORD_CHANNEL_SIMPLECLAW && env.DISCORD_CHANNEL_CLAW) {
    log.warn(
      'DISCORD_CHANNEL_CLAW is deprecated — rename to DISCORD_CHANNEL_SIMPLECLAW in your .env when convenient.',
    );
  }

  // Backwards compat: if only legacy claw.db exists, rename it to simpleclaw.db in place.
  const dbFile = path.join(env.DATA_DIR, 'simpleclaw.db');
  const legacyDbFile = path.join(env.DATA_DIR, 'claw.db');
  if (!fs.existsSync(dbFile) && fs.existsSync(legacyDbFile)) {
    log.warn({ legacyDbFile, dbFile }, 'migrating legacy claw.db → simpleclaw.db');
    fs.renameSync(legacyDbFile, dbFile);
    for (const suffix of ['-shm', '-wal']) {
      const legacySidecar = legacyDbFile + suffix;
      if (fs.existsSync(legacySidecar)) fs.renameSync(legacySidecar, dbFile + suffix);
    }
  }

  return {
    env,
    repoChannels,
    hubRepo,
    generalChannelId: env.DISCORD_CHANNEL_GENERAL,
    mailAlertChannelId: env.DISCORD_CHANNEL_MAIL_ALERTS ?? env.DISCORD_CHANNEL_GENERAL,
    simpleclawChannelId,
    wikiChannelId: env.DISCORD_CHANNEL_WIKI,
    rootChannelId: env.DISCORD_CHANNEL_ROOT,
    channelModels: simpleclawConfig.channelModels ?? {},
    wikiDir: env.WIKI_DIR,
    simpleclawRepoPath: process.cwd(),
    vmcDigest:
      env.VMC_BOT_TOKEN && env.VMC_DIGEST_CHANNEL_ID
        ? { botToken: env.VMC_BOT_TOKEN, channelId: env.VMC_DIGEST_CHANNEL_ID }
        : null,
    gmail,
    projectWizard: {
      githubScopes:
        simpleclawConfig.githubScopes ??
        [...new Set(repoChannels.map((r) => r.fullName.split('/')[0]))],
      reposDir: env.REPOS_DIR,
      channelCategoryId: simpleclawConfig.projectChannelCategoryId,
    },
    configFilePath,
    imessageEnabled: env.IMESSAGE_ENABLED,
    imessageAlertChannelId:
      env.DISCORD_CHANNEL_IMESSAGE_ALERTS ??
      env.DISCORD_CHANNEL_MAIL_ALERTS ??
      env.DISCORD_CHANNEL_GENERAL,
    paths: {
      dataDir: env.DATA_DIR,
      logsDir: env.LOGS_DIR,
      dbFile,
    },
  };
}
