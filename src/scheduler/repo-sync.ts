import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 10 * 60 * 1_000; // poll every 10 minutes
const IDLE_THRESHOLD_MS = 30 * 60 * 1_000; // only sync when idle 30+ minutes

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function isIdle(db: Database.Database): boolean {
  const row = db.prepare<[], { ts: string }>('SELECT ts FROM events ORDER BY ts DESC LIMIT 1').get();
  if (!row) return true;
  return Date.now() - new Date(row.ts).getTime() >= IDLE_THRESHOLD_MS;
}

interface SyncTarget {
  fullName: string;
  localPath: string;
}

async function gitSyncRepo(target: SyncTarget): Promise<string> {
  const { fullName, localPath } = target;
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: localPath });

    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: localPath,
    });
    const branch = branchOut.trim();

    if (branch === 'HEAD') {
      return `${fullName}: detached HEAD, skipped`;
    }

    // Try fast-forward merge first
    try {
      const { stdout } = await execFileAsync('git', ['merge', '--ff-only', `origin/${branch}`], {
        cwd: localPath,
      });
      const line = stdout.trim().split('\n').pop() ?? 'ok';
      return `${fullName} [${branch}]: ${line}`;
    } catch {
      // Fall back to rebase
      try {
        const { stdout } = await execFileAsync('git', ['rebase', `origin/${branch}`], { cwd: localPath });
        const line = stdout.trim().split('\n').pop() ?? 'rebased';
        return `${fullName} [${branch}]: rebased — ${line}`;
      } catch (rebaseErr) {
        await execFileAsync('git', ['rebase', '--abort'], { cwd: localPath }).catch(() => {});
        const msg = (rebaseErr as Error).message.split('\n')[0];
        return `${fullName} [${branch}]: FAIL — ${msg}`;
      }
    }
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0];
    return `${fullName}: FAIL — ${msg}`;
  }
}

export class RepoSyncScheduler {
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly notify: ((msg: string) => Promise<void>) | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, db: Database.Database, notify?: (msg: string) => Promise<void>) {
    this.config = config;
    this.db = db;
    this.notify = notify ?? null;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (!isIdle(this.db)) {
        log.debug('repo-sync: skipped (activity within last 30 min)');
        return;
      }
      void this.run();
    }, POLL_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    log.info({ pollIntervalMs: POLL_INTERVAL_MS, idleThresholdMs: IDLE_THRESHOLD_MS }, 'repo-sync: started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    const targets: SyncTarget[] = [
      ...this.config.repoChannels,
      { fullName: 'YeoulHi/claw', localPath: this.config.clawRepoPath },
    ];

    log.info({ count: targets.length }, 'repo-sync: running git pull on all repos');

    const results = await Promise.allSettled(targets.map(gitSyncRepo));
    const lines = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : `${targets[i].fullName}: ERROR — ${(r.reason as Error).message}`,
    );

    log.info({ results: lines }, 'repo-sync: done');

    if (this.notify) {
      const kstNow = new Date(Date.now() + KST_OFFSET_MS);
      const hhmm = `${String(kstNow.getUTCHours()).padStart(2, '0')}:${String(kstNow.getUTCMinutes()).padStart(2, '0')}`;
      const msg = `**[repo-sync ${hhmm} KST]**\n${lines.map((l) => `• ${l}`).join('\n')}`;
      await this.notify(msg).catch((err) => log.error({ err }, 'repo-sync: notify failed'));
    }
  }
}
