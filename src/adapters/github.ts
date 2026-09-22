/**
 * GitHub Issues + PRs adapter — polls watched repos for new issues/PRs and
 * creates Discord threads. If repo.autoSolveIssues is true, simple issues are
 * automatically resolved via Claude Code (branch → commit → push → PR).
 */

import type Database from 'better-sqlite3';

import type { AppConfig, RepoEntry } from '../config.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';
import {
  getGithubIssueState,
  setGithubIssueState,
  getGithubIssueThreadByIssue,
  setGithubIssueThread,
  updateGithubIssueAutoSolve,
  getGithubPrState,
  setGithubPrState,
  getGithubPrThreadByPr,
  setGithubPrThread,
} from '../state/github.js';
import { emitEvent } from '../dashboard/event-bus.js';
import type { MailAlertPoster } from '../messenger/types.js';
import { classifyIssueComplexity, autoSolveIssue, type IssueInfo } from '../orchestrator/issue-solver.js';

const THREAD_NAME_MAX = 90;
const BODY_TRUNCATE = 3000;

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  body?: string | null;
  pull_request?: unknown;
  labels: Array<{ name: string }>;
}

interface GitHubPR {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  body?: string | null;
  draft: boolean;
  base: { ref: string };
  head: { ref: string };
  labels: Array<{ name: string }>;
}

interface ChannelAndThreadPoster extends MailAlertPoster {
  postToChannel(channelId: string, content: string): Promise<void>;
}

interface GitHubIssueAdapterOpts {
  config: AppConfig;
  db: Database.Database;
  poster: ChannelAndThreadPoster;
}

function formatKst(iso: string): string {
  let date: Date;
  try {
    date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
  } catch {
    return iso;
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const out = fmt.format(date).replace(', ', ' ').replace(',', ' ');
  return `${out} KST`;
}

function truncateThreadName(s: string, max = THREAD_NAME_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export class GitHubIssueAdapter {
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly poster: ChannelAndThreadPoster;
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: GitHubIssueAdapterOpts) {
    this.config = opts.config;
    this.db = opts.db;
    this.poster = opts.poster;
    this.intervalMs = Math.max(60_000, opts.config.env.MAIL_POLL_INTERVAL_SEC * 1000);
  }

  // Evaluated per cycle (not cached) — the new-project wizard appends repos at runtime.
  private get issueRepos(): RepoEntry[] {
    return this.config.repoChannels.filter((r) => r.watchIssues);
  }

  private get prRepos(): RepoEntry[] {
    return this.config.repoChannels.filter((r) => r.watchPrs);
  }

  async start(): Promise<void> {
    // Keep polling even with nothing watched yet — repos can be added at runtime.
    log.info(
      {
        issueRepos: this.issueRepos.map((r) => r.fullName),
        prRepos: this.prRepos.map((r) => r.fullName),
        intervalMs: this.intervalMs,
      },
      'github adapter starting',
    );
    await this.runCycle();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      if (this.cycleInFlight) {
        log.debug('github adapter: previous cycle still running, skipping tick');
        return;
      }
      void this.runCycle();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('github adapter stopped');
  }

  // ---------- internals ----------

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight) return;
    const p = this.doCycle().finally(() => {
      this.cycleInFlight = null;
    });
    this.cycleInFlight = p;
    await p;
  }

  private async doCycle(): Promise<void> {
    for (const repo of this.issueRepos) {
      if (this.stopped) return;
      try {
        await this.pollIssues(repo);
      } catch (err) {
        log.error({ repo: repo.fullName, err: (err as Error).message }, 'github cycle: issues error');
      }
    }
    for (const repo of this.prRepos) {
      if (this.stopped) return;
      try {
        await this.pollPrs(repo);
      } catch (err) {
        log.error({ repo: repo.fullName, err: (err as Error).message }, 'github cycle: PRs error');
      }
    }
  }

  private async pollIssues(repo: RepoEntry): Promise<void> {
    const state = getGithubIssueState(this.db, repo.fullName);

    const url = `https://api.github.com/repos/${repo.fullName}/issues?state=all&sort=created&direction=desc&per_page=20`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'claw-bot/1.0',
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.error({ repo: repo.fullName, status: resp.status, body }, 'github: API error');
      return;
    }

    const issues = (await resp.json()) as GitHubIssue[];

    // Bootstrap: record current max issue number, skip alerting backlog.
    if (!state) {
      const maxNum = issues.length > 0 ? Math.max(...issues.map((i) => i.number)) : 0;
      setGithubIssueState(this.db, repo.fullName, maxNum);
      log.info({ repo: repo.fullName, maxIssueNumber: maxNum }, 'github bootstrap complete');
      return;
    }

    // Filter PRs out and find new issues.
    const newIssues = issues
      .filter((i) => !i.pull_request && i.number > state.lastIssueNumber)
      .sort((a, b) => a.number - b.number); // oldest first

    if (newIssues.length === 0) return;

    for (const issue of newIssues) {
      if (this.stopped) break;
      await this.postIssueThread(repo, issue);
    }

    const newMax = Math.max(...newIssues.map((i) => i.number), state.lastIssueNumber);
    setGithubIssueState(this.db, repo.fullName, newMax);

    log.info(
      { repo: repo.fullName, count: newIssues.length, newMax },
      'github: new issue threads posted',
    );
  }

  private async postIssueThread(repo: RepoEntry, issue: GitHubIssue): Promise<void> {
    // Idempotency: skip if thread already exists for this issue.
    const existing = getGithubIssueThreadByIssue(this.db, repo.fullName, issue.number);
    if (existing) {
      log.debug({ repo: repo.fullName, issue: issue.number }, 'github: thread already exists, skipping');
      return;
    }

    const author = issue.user?.login ?? '(unknown)';
    const ts = formatKst(issue.created_at);
    const labelStr = issue.labels.map((l) => `\`${l.name}\``).join(' ');

    const threadName = truncateThreadName(`🐛 #${issue.number}: ${issue.title}`);

    const initialMessage = [
      `🐛 **새 이슈 #${issue.number}**: ${issue.title}`,
      `📁 ${repo.fullName} | 👤 ${author} | 📅 ${ts}${labelStr ? ` | ${labelStr}` : ''}`,
      issue.html_url,
    ].join('\n');

    const bodyText = (issue.body ?? '').trim() || '(본문 없음)';
    const truncatedBody = bodyText.length > BODY_TRUNCATE
      ? `${bodyText.slice(0, BODY_TRUNCATE)}\n…(이하 생략)`
      : bodyText;

    const threadFirstMessage = [
      `📋 **이슈 #${issue.number}**: ${issue.title}`,
      `🔗 ${issue.html_url}`,
      '',
      '**본문:**',
      '```',
      truncatedBody,
      '```',
    ].join('\n');

    let posted: { threadId: string; firstMessageId: string };
    try {
      posted = await this.poster.postMailAlert({
        channelId: repo.channelId,
        threadName,
        initialMessage,
        threadFirstMessage,
      });
    } catch (err) {
      log.error(
        { repo: repo.fullName, issue: issue.number, err: (err as Error).message },
        'github: discord thread post failed',
      );
      return;
    }

    setGithubIssueThread(this.db, {
      repo: repo.fullName,
      issueNumber: issue.number,
      discordThreadId: posted.threadId,
      discordMessageId: posted.firstMessageId,
    });

    logEvent(this.db, {
      type: 'github.issue.alert',
      channel: repo.channelName,
      threadId: posted.threadId,
      summary: `#${issue.number} ${issue.title}`,
      meta: { repo: repo.fullName, issueNumber: issue.number, author },
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'github.issue.alert',
      channel: repo.channelName,
      threadId: posted.threadId,
      summary: `#${issue.number} ${issue.title}`,
    });

    // Auto-solve: fire-and-forget (non-blocking so polling continues)
    if (repo.autoSolveIssues) {
      const issueInfo: IssueInfo = {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        htmlUrl: issue.html_url,
      };
      setImmediate(() => void this.tryAutoSolve(repo, issueInfo, posted.threadId));
    }
  }

  private async tryAutoSolve(
    repo: RepoEntry,
    issue: IssueInfo,
    threadId: string,
  ): Promise<void> {
    const postToThread = (msg: string) =>
      this.poster.postToChannel(threadId, msg).catch((err) =>
        log.warn({ threadId, err: (err as Error).message }, 'github: thread post failed'),
      );

    try {
      // 1. Classify complexity
      updateGithubIssueAutoSolve(this.db, repo.fullName, issue.number, 'classifying');
      await postToThread('🤖 **복잡도 분석 중...**');

      const { verdict, reason } = await classifyIssueComplexity(issue, this.config);
      log.info({ repo: repo.fullName, issue: issue.number, verdict, reason }, 'issue classified');

      if (verdict === 'complex') {
        updateGithubIssueAutoSolve(this.db, repo.fullName, issue.number, 'skipped');
        await postToThread(`🧠 **복잡도: 높음** — 수동 처리 필요\n> ${reason}`);
        return;
      }

      // 2. Auto-solve
      await postToThread(`✅ **복잡도: 낮음** — 자동 처리 시작\n> ${reason}`);
      updateGithubIssueAutoSolve(this.db, repo.fullName, issue.number, 'solving');
      await postToThread('⚙️ **branch 생성 → Claude Code 실행 중...** (최대 15분 소요)');

      const result = await autoSolveIssue({ repo, issue, db: this.db, config: this.config });

      if (result.success && result.prUrl) {
        updateGithubIssueAutoSolve(this.db, repo.fullName, issue.number, 'done', result.prUrl);
        await postToThread([
          `🎉 **PR 생성 완료**`,
          `🔗 ${result.prUrl}`,
          result.summary ? `📝 ${result.summary}` : '',
        ].filter(Boolean).join('\n'));
      } else {
        updateGithubIssueAutoSolve(this.db, repo.fullName, issue.number, 'error');
        await postToThread(`❌ **자동 처리 실패**: ${result.error ?? '알 수 없는 오류'}`);
      }
    } catch (err) {
      updateGithubIssueAutoSolve(this.db, repo.fullName, issue.number, 'error');
      log.error({ repo: repo.fullName, issue: issue.number, err: (err as Error).message }, 'tryAutoSolve: unexpected error');
      await postToThread(`❌ **자동 처리 오류**: ${(err as Error).message}`);
    }
  }

  // ---------- PR polling ----------

  private async pollPrs(repo: RepoEntry): Promise<void> {
    const state = getGithubPrState(this.db, repo.fullName);

    const url = `https://api.github.com/repos/${repo.fullName}/pulls?state=all&sort=created&direction=desc&per_page=20`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'claw-bot/1.0',
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.error({ repo: repo.fullName, status: resp.status, body }, 'github: PR API error');
      return;
    }

    const prs = (await resp.json()) as GitHubPR[];

    if (!state) {
      const maxNum = prs.length > 0 ? Math.max(...prs.map((p) => p.number)) : 0;
      setGithubPrState(this.db, repo.fullName, maxNum);
      log.info({ repo: repo.fullName, maxPrNumber: maxNum }, 'github PR bootstrap complete');
      return;
    }

    const newPrs = prs
      .filter((p) => p.number > state.lastPrNumber)
      .sort((a, b) => a.number - b.number);

    if (newPrs.length === 0) return;

    for (const pr of newPrs) {
      if (this.stopped) break;
      await this.postPrThread(repo, pr);
    }

    const newMax = Math.max(...newPrs.map((p) => p.number), state.lastPrNumber);
    setGithubPrState(this.db, repo.fullName, newMax);

    log.info({ repo: repo.fullName, count: newPrs.length, newMax }, 'github: new PR threads posted');
  }

  private async postPrThread(repo: RepoEntry, pr: GitHubPR): Promise<void> {
    const existing = getGithubPrThreadByPr(this.db, repo.fullName, pr.number);
    if (existing) {
      log.debug({ repo: repo.fullName, pr: pr.number }, 'github: PR thread already exists, skipping');
      return;
    }

    const author = pr.user?.login ?? '(unknown)';
    const ts = formatKst(pr.created_at);
    const labelStr = pr.labels.map((l) => `\`${l.name}\``).join(' ');
    const draftTag = pr.draft ? ' `draft`' : '';

    const threadName = truncateThreadName(`🔀 #${pr.number}: ${pr.title}`);

    const initialMessage = [
      `🔀 **새 PR #${pr.number}**${draftTag}: ${pr.title}`,
      `📁 ${repo.fullName} | 👤 ${author} | 📅 ${ts} | \`${pr.head.ref}\` → \`${pr.base.ref}\`${labelStr ? ` | ${labelStr}` : ''}`,
      pr.html_url,
    ].join('\n');

    const bodyText = (pr.body ?? '').trim() || '(본문 없음)';
    const truncatedBody = bodyText.length > BODY_TRUNCATE
      ? `${bodyText.slice(0, BODY_TRUNCATE)}\n…(이하 생략)`
      : bodyText;

    const threadFirstMessage = [
      `📋 **PR #${pr.number}**: ${pr.title}`,
      `🔗 ${pr.html_url}`,
      `🌿 \`${pr.head.ref}\` → \`${pr.base.ref}\``,
      '',
      '**본문:**',
      '```',
      truncatedBody,
      '```',
    ].join('\n');

    let posted: { threadId: string; firstMessageId: string };
    try {
      posted = await this.poster.postMailAlert({
        channelId: repo.channelId,
        threadName,
        initialMessage,
        threadFirstMessage,
      });
    } catch (err) {
      log.error(
        { repo: repo.fullName, pr: pr.number, err: (err as Error).message },
        'github: PR discord thread post failed',
      );
      return;
    }

    setGithubPrThread(this.db, {
      repo: repo.fullName,
      prNumber: pr.number,
      discordThreadId: posted.threadId,
      discordMessageId: posted.firstMessageId,
    });

    logEvent(this.db, {
      type: 'github.pr.alert',
      channel: repo.channelName,
      threadId: posted.threadId,
      summary: `PR #${pr.number} ${pr.title}`,
      meta: { repo: repo.fullName, prNumber: pr.number, author },
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'github.pr.alert',
      channel: repo.channelName,
      threadId: posted.threadId,
      summary: `PR #${pr.number} ${pr.title}`,
    });
  }
}
