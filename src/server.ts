import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import fs from 'node:fs';

import { loadConfig } from './config.js';
import { log } from './log.js';
import { getDb, closeDb } from './state/db.js';
import { logEvent } from './state/events.js';
import { mountDashboard } from './dashboard/routes.js';
import { GatewayIpc } from './ipc/server.js';
import { DiscordGatewayAdapter } from './adapters/discord-gateway.js';
import { GmailAdapter } from './adapters/gmail.js';
import { GitHubIssueAdapter } from './adapters/github.js';
import { RepoSyncScheduler } from './scheduler/repo-sync.js';
import { DreamingScheduler } from './scheduler/dreaming.js';
import { WikiScanScheduler } from './scheduler/wiki-scan.js';
import { DailyDigestScheduler } from './scheduler/daily-digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

async function getGitCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function formatKst(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return fmt.format(new Date(iso)).replace(', ', ' ').replace(',', ' ') + ' KST';
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = new Date().toISOString();
  const commitHash = await getGitCommit(process.cwd());

  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.mkdirSync(config.paths.logsDir, { recursive: true });

  log.info({ pid: process.pid, commit: commitHash, dbFile: config.paths.dbFile, repos: config.repoChannels.length }, 'SimpleClaw gateway starting');

  const db = getDb(config.paths.dbFile);

  const gmailCount = config.gmail.length;
  const githubCount = config.repoChannels.filter((r) => r.watchIssues).length;

  // Express app + dashboard
  const app = express();
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      commit: commitHash,
      startedAt,
      adapters: { gmail: gmailCount, github: githubCount },
    });
  });

  // Manual trigger for wiki source scan (requires Authorization: Bearer <DASHBOARD_SECRET>)
  app.post('/admin/wiki-scan', express.json(), (req, res) => {
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${config.env.DASHBOARD_SECRET}`) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    if (!config.wikiChannelId) {
      res.status(400).json({ ok: false, error: 'DISCORD_CHANNEL_WIKI not configured' });
      return;
    }
    void discord.triggerWikiScan().catch((err) => {
      log.error({ err: (err as Error).message }, 'wiki-scan trigger failed');
    });
    log.info('wiki-scan manually triggered via /admin/wiki-scan');
    res.json({ ok: true, message: 'wiki-scan triggered' });
  });

  // Manual trigger for VMC Daily Digest (requires Authorization: Bearer <DASHBOARD_SECRET>)
  app.post('/admin/daily-digest', express.json(), (req, res) => {
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${config.env.DASHBOARD_SECRET}`) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    if (!dailyDigest) {
      res.status(400).json({ ok: false, error: 'VMC_BOT_TOKEN / VMC_DIGEST_CHANNEL_ID not configured' });
      return;
    }
    void dailyDigest.runDigest().then((result) => {
      log.info(result, 'daily-digest manually triggered via /admin/daily-digest');
    }).catch((err) => {
      log.error({ err: (err as Error).message }, 'daily-digest trigger failed');
    });
    log.info('daily-digest manually triggered via /admin/daily-digest');
    res.json({ ok: true, message: 'daily-digest triggered' });
  });

  mountDashboard(app, { db, secret: config.env.DASHBOARD_SECRET });
  const server = app.listen(config.env.DASHBOARD_PORT, () => {
    log.info({ port: config.env.DASHBOARD_PORT }, 'dashboard listening');
  });

  // Worker binary path (sibling dist/worker.js)
  const workerBin = path.join(__dirname, 'worker.js');

  // IPC server — spawns and manages the Worker process
  const ipc = new GatewayIpc({
    workerBin,
    cwd: path.dirname(__dirname), // project root
    env: process.env,
  });
  await ipc.start();

  // Discord gateway adapter — holds Discord.js client
  const discord = new DiscordGatewayAdapter({ config, db, ipc });
  await discord.start();

  // Repo sync: polls every 10 min, only runs when idle 30+ min
  const simpleclawOrGeneral = config.simpleclawChannelId ?? config.generalChannelId;
  const repoSync = new RepoSyncScheduler(config, db, (msg) =>
    discord.postToChannel(simpleclawOrGeneral, msg),
  );
  repoSync.start();

  // Dreaming: memory decay/promote during sleep hours, once per day
  const dreaming = new DreamingScheduler(db, (msg) =>
    discord.postToChannel(simpleclawOrGeneral, msg),
  );
  dreaming.start();

  // Wiki scan: daily source briefing to claw-wiki channel (runs in Gateway to survive Worker restart)
  const wikiScan = new WikiScanScheduler(config, () => discord.triggerWikiScan());
  wikiScan.start();

  // VMC Daily Digest: posts newly ingested wiki items to VMC club Discord at noon KST
  let dailyDigest: DailyDigestScheduler | null = null;
  if (config.vmcDigest) {
    dailyDigest = new DailyDigestScheduler(
      config.wikiDir,
      config.vmcDigest.botToken,
      config.vmcDigest.channelId,
    );
    dailyDigest.start();
    log.info({ channelId: config.vmcDigest.channelId }, 'daily-digest scheduler started');
  }

  // Gmail (optional — only if configured)
  let gmail: GmailAdapter | null = null;
  const gmailReady = config.gmail.length > 0 && config.env.GMAIL_CLIENT_ID && config.env.GMAIL_CLIENT_SECRET;
  if (gmailReady) {
    gmail = new GmailAdapter({ config, db, poster: discord });
    await gmail.start();
    log.info({ accounts: config.gmail.length }, 'gmail adapter started');
  } else {
    log.warn(
      { configured: config.gmail.length, hasClient: !!config.env.GMAIL_CLIENT_ID },
      'gmail not configured — skipping (run scripts/gmail-auth.ts to enable)',
    );
  }

  // GitHub Issues (polls repos where watchIssues: true)
  const github = new GitHubIssueAdapter({ config, db, poster: discord });
  await github.start();

  // Startup notification — visible in Discord so stale-gateway issues are immediately detectable
  const startupMsg = [
    `🔄 **gateway 재기동** | commit: \`${commitHash}\` | ${formatKst(startedAt)}`,
    `📦 gmail: ${gmailCount}계정 | github: ${githubCount} repo`,
  ].join('\n');
  try {
    await discord.postToChannel(config.simpleclawChannelId ?? config.generalChannelId, startupMsg);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'startup notification failed');
  }
  logEvent(db, {
    type: 'gateway.start',
    channel: 'simpleclaw',
    summary: `commit: ${commitHash} | gmail:${gmailCount} github:${githubCount}`,
    meta: { commit: commitHash, startedAt, gmail: gmailCount, github: githubCount },
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');
    try {
      server.close();
      repoSync.stop();
      dreaming.stop();
      wikiScan.stop();
      dailyDigest?.stop();
      await discord.stop();
      if (gmail) await gmail.stop();
      github.stop();
      await ipc.stop();
      closeDb();
    } catch (err) {
      log.error({ err }, 'shutdown error');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: { message: err.message, stack: err.stack } }, 'uncaughtException');
    void shutdown('uncaughtException');
  });

  log.info({ commit: commitHash }, 'claw gateway running');
}

main().catch((err) => {
  log.fatal({ err: { message: err.message, stack: err.stack } }, 'fatal startup error');
  process.exit(1);
});
