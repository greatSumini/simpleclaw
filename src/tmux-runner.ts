import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { type Artifact, extractArtifacts } from './artifact.js';
import { log } from './log.js';

export interface TmuxRunOptions {
  cwd: string;
  prompt: string;
  systemAppend?: string;
  /** Unique key for this session — typically the Discord threadKey. */
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TmuxRunResult {
  text: string;
  sessionKey: string;
  durationMs: number;
  exitCode: number;
  artifacts: Artifact[];
}

export class TmuxError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TmuxError';
  }
}

// ── helpers (exported for testing) ────────────────────────────────────────

export function sanitizeSessionName(key: string): string {
  return `sc-${key.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 50)}`;
}

/** Strip ANSI escape codes from terminal output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B[()][0-9A-Z]/g, '');
}

/**
 * Extract the assistant's response from pane snapshots taken before/after
 * the message was sent.
 *
 * Strategy:
 *  1. Find the first line of the user's prompt in `after` (visual anchor).
 *  2. Return everything following that anchor.
 *  3. Fallback: return lines not present in `before`.
 */
export function extractResponse(before: string, after: string, prompt: string): string {
  const anchor = prompt.split('\n')[0]!.trim().slice(0, 100);
  if (anchor) {
    const idx = after.lastIndexOf(anchor);
    if (idx !== -1) {
      const slice = after.slice(idx + anchor.length).trim();
      if (slice.length > 0) {
        log.debug({ anchorLen: anchor.length, sliceLen: slice.length }, 'tmux: response extracted via anchor');
        return slice;
      }
    }
    log.debug({ anchor }, 'tmux: anchor not found in pane, using fallback');
  }

  // Fallback: lines that are new in `after` compared to `before`.
  const beforeLines = new Set(before.split('\n'));
  const newLines = after
    .split('\n')
    .filter((l) => !beforeLines.has(l))
    .join('\n')
    .trim();
  if (newLines.length > 0) {
    log.debug({ newLineCount: newLines.split('\n').length }, 'tmux: response extracted via line diff');
    return newLines;
  }

  log.warn('tmux: extractResponse fallback to full after pane');
  return after.trim();
}

/**
 * Post-process raw extracted pane text to remove Claude Code TUI chrome:
 * box drawing borders, role indicator lines (◈ Claude / ◈ Human), and the
 * bottom input indicator (│ > │ or standalone >).
 *
 * Call this after extractResponse() to get clean response text.
 */
export function cleanupPaneText(raw: string): string {
  return raw
    .split('\n')
    // Box drawing border lines: lines composed almost entirely of ─ │ ╭ ╰ ╮ ╯ and spaces
    .filter((l) => !/^[\s╭╰╮╯│─]+$/.test(l))
    // Role indicator lines: ◈ Claude, ◈ Human, ● Claude, ◉ Human, etc.
    .filter((l) => !/^[\s◈●◉✦⬡]\s*(Claude|Human|Assistant|User)\s*$/.test(l.trim()))
    // Input box indicator: │ > │  or  >  alone at end of pane
    .filter((l) => !/^\s*[│|]?\s*>\s*[│|]?\s*$/.test(l))
    // Trim trailing whitespace per line (TUI pads to terminal width)
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

// ── CmdRunner (injectable for tests) ──────────────────────────────────────

export type CmdRunner = (args: string[]) => Promise<{ out: string; code: number }>;

export function makeRealCmdRunner(): CmdRunner {
  return (args: string[]) =>
    new Promise((resolve) => {
      const proc = spawn(args[0]!, args.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      proc.once('close', (code) => resolve({ out, code: code ?? 1 }));
      proc.once('error', () => resolve({ out, code: 1 }));
    });
}

// ── Mutex ──────────────────────────────────────────────────────────────────

class Mutex {
  private queue: Array<() => void> = [];
  private held = false;

  acquire(): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }
}

// ── constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getClaudeBin(): string {
  return process.env['CLAUDE_BIN'] ?? 'claude';
}

export interface TmuxRunnerOptions {
  cmdRunner?: CmdRunner;
  /** ms to wait after spawning Claude for TUI init. Default 8000. */
  initWaitMs?: number;
  /** Polling interval while waiting for response. Default 800. */
  pollMs?: number;
  /** Consecutive stable polls required. Default 3. */
  stablePolls?: number;
  /** Minimum elapsed ms before accepting stable. Default 4000. */
  minWaitMs?: number;
}

// ── TmuxRunner ─────────────────────────────────────────────────────────────

export class TmuxRunner {
  private sessions = new Map<string, { name: string; mutex: Mutex }>();
  private cmd: CmdRunner;
  private initWaitMs: number;
  private pollMs: number;
  private stablePolls: number;
  private minWaitMs: number;

  constructor(options?: TmuxRunnerOptions | CmdRunner) {
    if (typeof options === 'function') {
      this.cmd = options;
      this.initWaitMs = 8_000;
      this.pollMs = 800;
      this.stablePolls = 3;
      this.minWaitMs = 4_000;
    } else {
      this.cmd = options?.cmdRunner ?? makeRealCmdRunner();
      this.initWaitMs = options?.initWaitMs ?? 8_000;
      this.pollMs = options?.pollMs ?? 800;
      this.stablePolls = options?.stablePolls ?? 3;
      this.minWaitMs = options?.minWaitMs ?? 4_000;
    }
  }

  private getSession(key: string): { name: string; mutex: Mutex } {
    let s = this.sessions.get(key);
    if (!s) {
      s = { name: sanitizeSessionName(key), mutex: new Mutex() };
      this.sessions.set(key, s);
    }
    return s;
  }

  /**
   * Ensure a tmux session running `claude` exists for the given session name.
   * No-ops if the session is already alive.
   */
  async ensureSession(name: string, cwd: string): Promise<void> {
    const { code } = await this.cmd(['tmux', 'has-session', '-t', name]);
    if (code === 0) {
      log.debug({ name }, 'tmux: session already alive');
      return;
    }

    log.info({ name, cwd }, 'tmux: creating new session');
    await this.cmd(['tmux', 'new-session', '-d', '-s', name, '-c', cwd, getClaudeBin()]);
    // Wait for Claude's TUI to fully initialize before we interact with it.
    await sleep(this.initWaitMs);
    log.info({ name }, 'tmux: session ready after init wait');
  }

  /** Capture the full scrollback + visible pane content as plain text. */
  async capturePane(name: string): Promise<string> {
    // -J joins wrapped lines; -S -3000 includes up to 3000 lines of scrollback.
    const { out } = await this.cmd(['tmux', 'capture-pane', '-t', name, '-p', '-J', '-S', '-3000']);
    return stripAnsi(out);
  }

  /**
   * Send a (potentially multi-line) message to the tmux session using the
   * paste-buffer mechanism, then press Enter to submit.
   */
  async sendMessage(name: string, message: string): Promise<void> {
    const tmpPath = path.join(os.tmpdir(), `sc-tmux-${Date.now()}.txt`);
    await fs.writeFile(tmpPath, message, 'utf8');
    log.debug({ name, msgLen: message.length, tmpPath }, 'tmux: sending message via paste-buffer');
    try {
      await this.cmd(['tmux', 'load-buffer', tmpPath]);
      await this.cmd(['tmux', 'paste-buffer', '-t', name]);
      // Brief pause so the TUI can register the pasted content before Enter.
      await sleep(200);
      await this.cmd(['tmux', 'send-keys', '-t', name, '', 'Enter']);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Poll the pane until output has been stable for STABLE_POLLS consecutive
   * reads (each POLL_MS apart), with a minimum elapsed time of MIN_WAIT_MS.
   */
  async waitUntilStable(
    name: string,
    startMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    let prev = '';
    let stableCount = 0;
    let pollCount = 0;

    while (true) {
      if (signal?.aborted) throw new TmuxError('aborted');
      const elapsed = Date.now() - startMs;
      if (elapsed > timeoutMs) throw new TmuxError(`timeout after ${timeoutMs}ms`);

      await sleep(this.pollMs);
      pollCount++;

      const pane = await this.capturePane(name);

      if (pane === prev && elapsed >= this.minWaitMs) {
        stableCount++;
        log.debug({ name, stableCount, elapsed, pollCount }, 'tmux: pane stable');
        if (stableCount >= this.stablePolls) {
          log.info({ name, elapsed, pollCount }, 'tmux: response stable — done');
          return pane;
        }
      } else {
        if (pane !== prev) {
          log.debug({ name, elapsed, paneLen: pane.length, pollCount }, 'tmux: pane changed');
        }
        stableCount = 0;
        prev = pane;
      }
    }
  }

  async run(opts: TmuxRunOptions): Promise<TmuxRunResult> {
    const start = Date.now();
    const { cwd, prompt, systemAppend, sessionKey, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

    const sess = this.getSession(sessionKey);

    log.info({ sessionKey, name: sess.name, cwd }, 'tmux run: start');

    const release = await sess.mutex.acquire();
    try {
      await this.ensureSession(sess.name, cwd);

      // Prepend systemAppend instructions to the prompt so Claude sees them
      // as part of the user turn (consistent with --print mode behaviour).
      const fullMsg = systemAppend ? `${prompt}\n\n---\n${systemAppend}` : prompt;

      const before = await this.capturePane(sess.name);
      log.debug({ name: sess.name, beforeLen: before.length }, 'tmux: pane snapshot before send');

      await this.sendMessage(sess.name, fullMsg);

      const after = await this.waitUntilStable(sess.name, start, timeoutMs, signal);

      const raw = cleanupPaneText(extractResponse(before, after, prompt));
      const durationMs = Date.now() - start;
      const { text, artifacts } = extractArtifacts(raw);

      log.info({ sessionKey, durationMs, textLen: text.length, artifactCount: artifacts.length }, 'tmux run ok');
      return { text, sessionKey, durationMs, exitCode: 0, artifacts };
    } finally {
      release();
    }
  }

  async kill(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    await this.cmd(['tmux', 'kill-session', '-t', s.name]);
    this.sessions.delete(key);
    log.info({ key, name: s.name }, 'tmux: session killed');
  }

  async killAll(): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      await this.kill(key);
    }
  }
}

export const tmuxRunner = new TmuxRunner();
