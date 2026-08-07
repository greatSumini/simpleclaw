import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { log } from '../log.js';
import { getPendingBackgroundJobs, markBackgroundJobStatus } from '../state/background-jobs.js';

const execAsync = promisify(exec);

const POLL_INTERVAL_MS = 5 * 60 * 1_000; // poll every 5 minutes
const CHECK_TIMEOUT_MS = 60 * 1_000;

/**
 * Polls `background_jobs` for objectively-checkable completion conditions
 * (e.g. `gh pr view 123 --json state -q .state | grep -q MERGED`) registered
 * by a Claude session via direct sqlite insert. Runs `check_cmd`; exit 0 means
 * done — posts `done_message` to the originating thread. Purely mechanical:
 * no LLM call in the polling loop, only (optionally) when composing the job.
 */
export class BackgroundJobScheduler {
  private readonly db: Database.Database;
  private readonly notify: (threadId: string, msg: string) => Promise<void>;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Database.Database, notify: (threadId: string, msg: string) => Promise<void>) {
    this.db = db;
    this.notify = notify;
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.run();
    }, POLL_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    log.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'background-jobs: started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    const jobs = getPendingBackgroundJobs(this.db);
    if (jobs.length === 0) return;

    for (const job of jobs) {
      if (new Date(job.expiresAt).getTime() <= Date.now()) {
        markBackgroundJobStatus(this.db, job.id, 'expired');
        await this.notify(
          job.threadId,
          `⏱️ 백그라운드 작업 시간 초과: ${job.description}\n(조건: \`${job.checkCmd}\`)`,
        ).catch((err) => log.error({ err, jobId: job.id }, 'background-jobs: expire notify failed'));
        continue;
      }

      try {
        await execAsync(job.checkCmd, { cwd: job.cwd, timeout: CHECK_TIMEOUT_MS });
        markBackgroundJobStatus(this.db, job.id, 'done');
        await this.notify(job.threadId, job.doneMessage).catch((err) =>
          log.error({ err, jobId: job.id }, 'background-jobs: done notify failed'),
        );
      } catch {
        // check_cmd exited non-zero (or timed out) — not done yet, try again next poll.
      }
    }
  }
}
