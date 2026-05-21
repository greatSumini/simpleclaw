/**
 * GitHub issue auto-solver.
 *
 * Two exports:
 *   classifyIssueComplexity — LLM call to decide simple vs complex
 *   autoSolveIssue          — branch → claude code → commit → push → PR
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';

import type { AppConfig, RepoEntry } from '../config.js';
import { runClaude } from '../claude.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';
import { updateGithubIssueAutoSolve } from '../state/github.js';

const execFileAsync = promisify(execFile);

const CLASSIFIER_TIMEOUT_MS = 60_000;
const SOLVER_TIMEOUT_MS = 900_000; // 15 min

export type AutoSolveVerdict = 'simple' | 'complex';

export interface ClassifyIssueResult {
  verdict: AutoSolveVerdict;
  reason: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
}

export interface AutoSolveResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  summary?: string;
}

// ---------- helpers ----------

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// ---------- classifier ----------

function buildClassifierPrompt(issue: IssueInfo): string {
  const body = (issue.body ?? '').trim() || '(no body)';
  return [
    '당신은 GitHub 이슈 복잡도 분류기.',
    '',
    `제목: ${issue.title}`,
    '본문:',
    body.slice(0, 1500),
    '',
    'AI 코딩 어시스턴트가 사용자 개입 없이 자율적으로 해결 가능한지 판단하라.',
    '',
    'SIMPLE (자동 해결 가능):',
    '- 명확한 버그 (재현 조건 + 기대 동작 명시)',
    '- 오타/문서 수정',
    '- 누락된 설정값 추가 (명확한 정답 존재)',
    '- 의사결정 없는 단순 리팩토링',
    '',
    'COMPLEX (사람 필요):',
    '- 기능 요청 또는 설계 결정 필요',
    '- 여러 구현 방법 중 선택 필요',
    '- 불명확한 요구사항',
    '- 외부 서비스/API/인증 접근 필요',
    '- 비즈니스 도메인 지식 필요',
    '',
    '정확히 JSON 한 줄 (markdown fence 금지):',
    '{"verdict":"simple","reason":"<한 줄>"}',
    '또는',
    '{"verdict":"complex","reason":"<한 줄>"}',
  ].join('\n');
}

export async function classifyIssueComplexity(
  issue: IssueInfo,
  config: AppConfig,
): Promise<ClassifyIssueResult> {
  const prompt = buildClassifierPrompt(issue);
  let raw: string;
  try {
    const result = await runClaude({ cwd: config.simpleclawRepoPath, prompt, timeoutMs: CLASSIFIER_TIMEOUT_MS });
    raw = result.text;
  } catch (err) {
    log.warn({ issue: issue.number, err: (err as Error).message }, 'issue classifier: runClaude failed, defaulting to complex');
    return { verdict: 'complex', reason: 'classifier error' };
  }

  const cleaned = stripFences(raw);
  const candidate = extractJsonObject(cleaned) ?? cleaned;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    log.warn({ issue: issue.number, raw: raw.slice(0, 200) }, 'issue classifier: JSON parse failed, defaulting to complex');
    return { verdict: 'complex', reason: 'classifier parse error' };
  }

  const obj = parsed as Record<string, unknown>;
  if ((obj.verdict === 'simple' || obj.verdict === 'complex') && typeof obj.reason === 'string') {
    return { verdict: obj.verdict, reason: obj.reason };
  }
  return { verdict: 'complex', reason: 'invalid classifier response' };
}

// ---------- solver ----------

function buildSolverPrompt(issue: IssueInfo, repo: RepoEntry): string {
  const body = (issue.body ?? '').trim() || '(본문 없음)';
  return [
    `GitHub 이슈 #${issue.number}을 해결하라.`,
    `레포: ${repo.fullName}`,
    `이슈 URL: ${issue.htmlUrl}`,
    '',
    `제목: ${issue.title}`,
    '본문:',
    body,
    '',
    '지침:',
    '- 이슈를 분석하고 정확한 수정을 구현하라',
    '- 최소한의 변경으로 이슈를 해결하라 (관련 없는 파일 수정 금지)',
    '- commit/push는 하지 말라 — 코드 변경만 수행',
    '- 완료 후 수행한 작업을 한 줄로 요약하라',
  ].join('\n');
}

export async function autoSolveIssue(opts: {
  repo: RepoEntry;
  issue: IssueInfo;
  db: Database.Database;
  config: AppConfig;
}): Promise<AutoSolveResult> {
  const { repo, issue, db, config } = opts;
  const localPath = repo.localPath;

  // 1. Verify repo dir exists
  try {
    await execFileAsync('git', ['-C', localPath, 'rev-parse', '--git-dir']);
  } catch {
    return { success: false, error: `repo not found at ${localPath}` };
  }

  // 2. Get base branch and fetch latest
  const { stdout: branchOut } = await execFileAsync('git', ['-C', localPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = branchOut.trim();
  await execFileAsync('git', ['-C', localPath, 'fetch', 'origin', baseBranch]).catch(() => {});

  // 3. Create isolated worktree on a new branch
  const branchName = `fix/issue-${issue.number}-${slugify(issue.title)}`;
  const worktreePath = path.join(
    os.tmpdir(),
    `claw-wt-${repo.fullName.replace('/', '-')}-issue-${issue.number}`,
  );

  try {
    await execFileAsync('git', [
      '-C', localPath, 'worktree', 'add', worktreePath, '-b', branchName, `origin/${baseBranch}`,
    ]);
  } catch (err) {
    return { success: false, error: `worktree creation failed: ${(err as Error).message}` };
  }

  let success = false;
  try {
    // 4. Run Claude Code inside the isolated worktree
    updateGithubIssueAutoSolve(db, repo.fullName, issue.number, 'solving');
    const prompt = buildSolverPrompt(issue, repo);
    const result = await runClaude({ cwd: worktreePath, prompt, timeoutMs: SOLVER_TIMEOUT_MS });
    const summary = result.text.trim().split('\n').at(-1) ?? '';

    // 5. Check for changes
    const { stdout: afterStatus } = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain']);
    if (!afterStatus.trim()) {
      return { success: false, error: 'Claude made no code changes' };
    }

    // 6. Commit
    await execFileAsync('git', ['-C', worktreePath, 'add', '-A']);
    await execFileAsync('git', [
      '-C', worktreePath, 'commit',
      '-m', `fix: resolve issue #${issue.number} — ${issue.title.slice(0, 60)}`,
    ]);

    // 7. Push
    await execFileAsync('git', ['-C', worktreePath, 'push', 'origin', branchName]);

    // 8. Create PR
    const prBody = [
      `Resolves #${issue.number}`,
      '',
      `**이슈**: ${issue.title}`,
      `**자동 처리**: claw + Claude Code가 자동으로 작성한 PR입니다.`,
      '',
      `**작업 내용**: ${summary}`,
    ].join('\n');

    const { stdout: prOut } = await execFileAsync(
      'gh',
      [
        'pr', 'create',
        '--repo', repo.fullName,
        '--title', `fix: issue #${issue.number} — ${issue.title.slice(0, 60)}`,
        '--body', prBody,
        '--head', branchName,
        '--base', baseBranch,
      ],
      { env: { ...process.env, GH_TOKEN: config.env.GH_TOKEN } },
    );
    const prUrl = prOut.trim();

    logEvent(db, {
      type: 'github.issue.auto-solved',
      channel: repo.channelName,
      summary: `#${issue.number} → ${prUrl}`,
      meta: { repo: repo.fullName, issueNumber: issue.number, branchName, prUrl },
    });

    success = true;
    return { success: true, prUrl, summary };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    // Always remove worktree; on failure also delete the branch
    await execFileAsync('git', ['-C', localPath, 'worktree', 'remove', worktreePath, '--force']).catch(() => {});
    if (!success) {
      await execFileAsync('git', ['-C', localPath, 'branch', '-D', branchName]).catch(() => {});
    }
  }
}
