import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Artifact, extractArtifacts } from './artifact.js';
import { log } from './log.js';

export interface ClaudeRunOptions {
  /** Working directory for the claude session (where it looks for CLAUDE.md, .claude/skills/) */
  cwd: string;
  /** User message — sent to claude via stdin (avoids shell escaping). */
  prompt: string;
  /** Session ID to resume. Omit for a fresh session. */
  resume?: string;
  /**
   * Additional system-style instructions. Passed via `--append-system-prompt` when the CLI
   * supports it; otherwise appended after the prompt with a "---" separator.
   */
  systemAppend?: string;
  /**
   * Override model. Prefer a CLI alias ('opus' | 'sonnet' | 'haiku') so the resolved model
   * follows the latest generation; a full id ('claude-haiku-4-5-20251001') also works.
   * Omit to use the CLI's configured model.
   */
  model?: string;
  /** Cancellation. Default: none. */
  signal?: AbortSignal;
  /** Hard timeout in ms. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Extra env vars for the engine process (e.g. SIMPLECLAW_RUN_TOKEN for claw-job). */
  env?: Record<string, string>;
  /**
   * Use exactly this environment instead of inheriting `process.env`. For sessions that must not
   * see the owner's secrets: dotenv loads the whole `.env` into `process.env`, so merging would
   * hand GH_TOKEN, DISCORD_BOT_TOKEN and the Gmail refresh tokens to the engine. Takes precedence
   * over `env`.
   */
  envReplace?: Record<string, string>;
  /**
   * Path to a Seatbelt profile to confine the engine with (`sandbox-exec -f`). Spawn fails loudly
   * if the profile cannot be applied — never silently falls back to an unconfined process.
   */
  sandboxProfile?: string;
}

export interface ClaudeRunResult {
  /** The assistant's final reply text (to be sent to the user). */
  text: string;
  /** Session ID for the next --resume. Always set; for fresh sessions it's the newly-created one. */
  sessionId: string;
  /** Wall-clock duration. */
  durationMs: number;
  /** claude process exit code (0 on success). */
  exitCode: number;
  /** Parsed artifact markers stripped from text (files to attach, URLs to link). */
  artifacts: Artifact[];
  /** Total tokens in the current context window (input + output + cache). */
  contextWindowUsed: number;
  /** Model's max context window size. */
  contextWindowMax: number;
  /**
   * `total_cost_usd` from the CLI result. NOT reliably per-invocation: on `--resume` the CLI
   * sometimes carries the session's earlier cost forward and sometimes doesn't (observed
   * turn-by-turn within the same session), so summing it over-counts by an unknown amount.
   */
  costUsd: number;
  /**
   * Model that actually served the main thread, as reported by the CLI (e.g.
   * 'claude-sonnet-5'). Empty/absent when the output mode carries no model info.
   */
  model?: string;
  /** Account-wide subscription quota utilization from the last `rate_limit_event`, if emitted. */
  rateLimits?: RateLimitSnapshot;
}

export interface RateLimitWindow {
  /** 0..1 fraction of the window's quota used (CLI reports 2 decimal places). */
  utilization: number;
  /** Unix epoch seconds when the window resets. */
  resetsAt: number;
}

export interface RateLimitSnapshot {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
}

export class ClaudeError extends Error {
  exitCode: number;
  stderr: string;
  constructor(msg: string, exitCode: number, stderr: string) {
    super(msg);
    this.name = 'ClaudeError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

type OutputMode = 'stream-json' | 'json' | 'text';

interface CliCapabilities {
  outputMode: OutputMode;
  includePartialMessages: boolean;
  verbose: boolean;
  appendSystemPrompt: boolean;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const SIGKILL_GRACE_MS = 5_000;

/** Read at call time so tests can override process.env.CLAUDE_BIN. */
function getClaudeBin(): string {
  return process.env['CLAUDE_BIN'] ?? 'claude';
}

/**
 * Resolve a bare binary name against *our* PATH.
 *
 * `spawn` would do this itself, but under sandbox-exec the lookup moves into sandbox-exec's own
 * execvp(), which searches the PATH we hand the sandboxed session — deliberately minimal, and not
 * where claude is installed. Passing an absolute path keeps the two concerns separate.
 */
function resolveBin(bin: string): string {
  if (bin.includes('/')) return bin;
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return bin;
}

let capabilitiesPromise: Promise<CliCapabilities> | null = null;

/** Reset cached CLI capabilities — test use only. */
export function _resetCapabilitiesForTest(): void {
  capabilitiesPromise = null;
}

function detectCapabilities(): Promise<CliCapabilities> {
  if (capabilitiesPromise) return capabilitiesPromise;
  capabilitiesPromise = (async () => {
    const help = await runHelp();
    const caps: CliCapabilities = {
      outputMode: help.includes('stream-json')
        ? 'stream-json'
        : help.includes('"json"') || /--output-format[^\n]*\bjson\b/.test(help)
          ? 'json'
          : 'text',
      includePartialMessages: help.includes('--include-partial-messages'),
      verbose: /(^|\s)--verbose\b/.test(help),
      appendSystemPrompt: help.includes('--append-system-prompt'),
    };
    log.debug({ caps }, 'claude cli capabilities detected');
    return caps;
  })().catch((err) => {
    // If help discovery fails, fall back to a conservative default that matches modern claude.
    log.warn({ err: (err as Error).message }, 'claude --help probe failed; using conservative defaults');
    return {
      outputMode: 'stream-json',
      includePartialMessages: true,
      verbose: true,
      appendSystemPrompt: true,
    } satisfies CliCapabilities;
  });
  return capabilitiesPromise;
}

function runHelp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getClaudeBin(), ['--help'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    proc.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    proc.once('error', reject);
    proc.once('close', (code) => {
      if (code === 0 || out.length > 0) resolve(out + '\n' + err);
      else reject(new Error(`claude --help exited ${code}: ${err.trim()}`));
    });
  });
}

/**
 * Build the stdin payload.
 *
 * When the CLI supports `--append-system-prompt`, systemAppend is passed as a real system
 * prompt (see buildArgs) and the stdin payload is the bare user message. Only when that flag
 * is unavailable do we fall back to inlining it into the user turn.
 *
 * The distinction matters for cost: content inlined into the user turn is persisted in the
 * session transcript and re-sent on every subsequent `--resume`, so an N-turn thread pays for
 * N copies of it. A system prompt is sent once, in the cache-stable prefix.
 */
export function buildPrompt(
  prompt: string,
  systemAppend: string | undefined,
  caps: Pick<CliCapabilities, 'appendSystemPrompt'>,
): string {
  if (!caps.appendSystemPrompt && systemAppend && systemAppend.length > 0) {
    return `${prompt}\n\n---\n${systemAppend}`;
  }
  return prompt;
}

function buildArgs(opts: ClaudeRunOptions, caps: CliCapabilities): string[] {
  const args: string[] = ['--print', '--dangerously-skip-permissions'];
  args.push(`--output-format=${caps.outputMode}`);
  // --include-partial-messages and --verbose only make sense with stream-json.
  if (caps.outputMode === 'stream-json') {
    if (caps.verbose) args.push('--verbose');
    if (caps.includePartialMessages) args.push('--include-partial-messages');
  }
  if (opts.resume) {
    args.push('--resume', opts.resume);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (caps.appendSystemPrompt && opts.systemAppend && opts.systemAppend.length > 0) {
    args.push('--append-system-prompt', opts.systemAppend);
  }
  return args;
}

export interface StreamJsonObject {
  type?: string;
  subtype?: string;
  session_id?: string;
  /** Set on events emitted from inside a subagent (Task/Agent tool) — not the main thread. */
  parent_tool_use_id?: string | null;
  result?: string;
  is_error?: boolean;
  message?: {
    role?: string;
    /** Model that produced this assistant turn (full id, e.g. 'claude-sonnet-5'). */
    model?: string;
    content?: Array<{ type?: string; text?: string }> | string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    iterations?: Array<{
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }>;
  };
  modelUsage?: Record<string, { contextWindow?: number }>;
  rate_limit_info?: {
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
  };
}

function tryParseJson(line: string): StreamJsonObject | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamJsonObject;
  } catch {
    return null;
  }
}

function extractAssistantText(obj: StreamJsonObject): string {
  if (!obj.message) return '';
  if (obj.message.role && obj.message.role !== 'assistant') return '';
  const content = obj.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
  }
  return '';
}

/**
 * `home` is the engine process's HOME, which is not always ours: a sandboxed session runs with
 * HOME pointed at its own workspace, and its transcripts land there. Resolving against
 * `os.homedir()` unconditionally would look in the wrong place and break `--resume`.
 */
function sessionDir(cwd: string, home?: string): string {
  const encoded = cwd.replace(/\//g, '-');
  return path.join(home ?? os.homedir(), '.claude', 'projects', encoded);
}

/** Snapshot the byte-size of every .jsonl file in the session dir. */
export async function snapshotSessionFiles(cwd: string, home?: string): Promise<Map<string, number>> {
  const dir = sessionDir(cwd, home);
  const snapshot = new Map<string, number>();
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
    if (stat) snapshot.set(entry, stat.size);
  }
  return snapshot;
}

/**
 * Restore session files to their pre-snapshot state.
 * New files are deleted; files that grew are truncated back.
 */
export async function restoreSessionFiles(
  cwd: string,
  snapshot: Map<string, number>,
  home?: string,
): Promise<void> {
  const dir = sessionDir(cwd, home);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, entry);
    if (!snapshot.has(entry)) {
      await fs
        .unlink(filePath)
        .catch((err: Error) => log.warn({ err: err.message }, 'btw: delete session file failed'));
    } else {
      const origSize = snapshot.get(entry)!;
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.size > origSize) {
        const fd = await fs.open(filePath, 'r+');
        await fd.truncate(origSize).finally(() => fd.close());
      }
    }
  }
}

async function lookupLatestSessionId(cwd: string, home?: string): Promise<string> {
  // Encoding: claude stores sessions in ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
  // Encoded cwd: replace '/' with '-'. An absolute path like /Users/sumin becomes -Users-sumin.
  const dir = sessionDir(cwd, home);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const jsonl = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonl.length === 0) {
    throw new Error(`no session files found in ${dir}`);
  }
  let newest = '';
  let newestMtime = 0;
  for (const name of jsonl) {
    const full = path.join(dir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.mtimeMs > newestMtime) {
      newestMtime = stat.mtimeMs;
      newest = name;
    }
  }
  if (!newest) throw new Error(`could not stat any session file in ${dir}`);
  return newest.replace(/\.jsonl$/, '');
}

export interface ParseAccumulator {
  sessionId: string;
  /** Model of the last main-thread assistant turn. '' until an assistant event arrives. */
  model: string;
  resultText: string;
  resultSeen: boolean;
  resultIsError: boolean;
  assistantTextFallback: string;
  contextWindowUsed: number;
  contextWindowMax: number;
  costUsd: number;
  rateLimits?: RateLimitSnapshot;
}

export function newAccumulator(): ParseAccumulator {
  return {
    sessionId: '',
    model: '',
    resultText: '',
    resultSeen: false,
    resultIsError: false,
    assistantTextFallback: '',
    contextWindowUsed: 0,
    contextWindowMax: 0,
    costUsd: 0,
  };
}

function toRateLimitWindow(
  w: { utilization?: number; resetsAt?: number } | undefined,
): RateLimitWindow | undefined {
  if (!w || typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number') return undefined;
  return { utilization: w.utilization, resetsAt: w.resetsAt };
}

export function consumeJsonObject(acc: ParseAccumulator, obj: StreamJsonObject): void {
  if (obj.session_id && !acc.sessionId) acc.sessionId = obj.session_id;
  // Always update sessionId from result (it's the canonical one for resume).
  if (obj.type === 'result') {
    if (obj.session_id) acc.sessionId = obj.session_id;
    acc.resultSeen = true;
    acc.resultIsError = obj.subtype === 'error' || obj.is_error === true;
    if (typeof obj.result === 'string') acc.resultText = obj.result;
    if (typeof obj.total_cost_usd === 'number') acc.costUsd = obj.total_cost_usd;
    if (obj.usage) {
      // iterations[-1] = last API call's complete context (input + output). Prefer over
      // assistant-event data because it includes output_tokens, giving the true post-response fill.
      const lastIter = obj.usage.iterations?.at(-1);
      if (lastIter) {
        acc.contextWindowUsed =
          (lastIter.input_tokens ?? 0) +
          (lastIter.cache_creation_input_tokens ?? 0) +
          (lastIter.cache_read_input_tokens ?? 0) +
          (lastIter.output_tokens ?? 0);
      } else if (acc.contextWindowUsed === 0) {
        // Aggregate fallback — inflated for multi-turn sessions; only use if nothing better captured.
        const u = obj.usage;
        acc.contextWindowUsed =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
      }
    }
    if (obj.modelUsage) {
      const maxCtx = Math.max(0, ...Object.values(obj.modelUsage).map((m) => m.contextWindow ?? 0));
      if (maxCtx > 0) acc.contextWindowMax = maxCtx;
    }
  } else if (obj.type === 'rate_limit_event') {
    // Emitted before each API call; the last one is the freshest account-wide quota reading.
    const windows = obj.rate_limit_info?.unifiedWindows;
    if (windows) {
      const fiveHour = toRateLimitWindow(windows['five_hour']);
      const sevenDay = toRateLimitWindow(windows['seven_day']);
      if (fiveHour || sevenDay) acc.rateLimits = { fiveHour, sevenDay };
    }
  } else if (obj.type === 'assistant') {
    const t = extractAssistantText(obj);
    if (t) acc.assistantTextFallback += t;
    // Subagent calls have their own, unrelated context window — only the main thread counts.
    if (obj.parent_tool_use_id) return;
    // Same reason the guard above exists: a subagent may run on a different model than the thread.
    if (obj.message?.model) acc.model = obj.message.model;
    // Track the last assistant message's input tokens as the current context window fill.
    // Each assistant event corresponds to one API call; the last one reflects the actual
    // context size at the end of the invocation. output_tokens are generated, not "in" the window.
    if (obj.message?.usage) {
      const u = obj.message.usage;
      acc.contextWindowUsed =
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
    }
  }
}

export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return (async () => {
    const start = Date.now();
    const caps = await detectCapabilities();
    const args = buildArgs(opts, caps);
    const stdinPayload = buildPrompt(opts.prompt, opts.systemAppend, caps);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    log.debug(
      {
        cwd: opts.cwd,
        resume: opts.resume,
        outputMode: caps.outputMode,
        model: opts.model,
        promptLen: opts.prompt.length,
        systemAppendLen: opts.systemAppend?.length ?? 0,
      },
      'claude run start',
    );

    const engineEnv = opts.envReplace ?? (opts.env ? { ...process.env, ...opts.env } : process.env);
    const engineHome = opts.envReplace?.['HOME'] ?? opts.env?.['HOME'];
    // sandbox-exec execs the engine in-place, so signals, stdio and exit codes behave as before.
    const [bin, binArgs] = opts.sandboxProfile
      ? ([
          '/usr/bin/sandbox-exec',
          ['-f', opts.sandboxProfile, resolveBin(getClaudeBin()), ...args],
        ] as const)
      : ([getClaudeBin(), args] as const);

    return await new Promise<ClaudeRunResult>((resolve, reject) => {
      const proc = spawn(bin, binArgs as string[], {
        cwd: opts.cwd,
        env: engineEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const acc = newAccumulator();
      let stdoutTextBuf = ''; // for text output mode (final result is the whole stdout)
      let lineBuf = ''; // line-buffered partial chunk for stream-json
      let stderrBuf = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let sigkillTimer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const killHard = (): void => {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        sigkillTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, SIGKILL_GRACE_MS);
        sigkillTimer.unref();
      };

      const onAbort = (): void => {
        settle(() => {
          killHard();
          reject(new ClaudeError('claude run aborted', -1, stderrBuf));
        });
      };

      if (opts.signal) {
        if (opts.signal.aborted) {
          // Don't even spawn... but we already did. Kill immediately.
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      killTimer = setTimeout(() => {
        settle(() => {
          killHard();
          reject(
            new ClaudeError(`claude run exceeded timeout ${timeoutMs}ms`, -1, stderrBuf),
          );
        });
      }, timeoutMs);
      killTimer.unref();

      proc.on('error', (err) => {
        settle(() => {
          reject(new ClaudeError(`failed to spawn claude: ${err.message}`, -1, stderrBuf));
        });
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        if (caps.outputMode === 'stream-json') {
          lineBuf += s;
          let idx: number;
          while ((idx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, idx);
            lineBuf = lineBuf.slice(idx + 1);
            const obj = tryParseJson(line);
            if (obj) consumeJsonObject(acc, obj);
          }
        } else {
          stdoutTextBuf += s;
        }
      });

      proc.stdin.on('error', (err) => {
        // Most often EPIPE if the child closed early. Capture but don't reject directly —
        // the close handler will deal with the exit code.
        log.debug({ err: err.message }, 'claude stdin error');
      });

      // Write the prompt to stdin and close it so claude knows the input is complete.
      proc.stdin.end(stdinPayload, 'utf8');

      proc.on('close', (code, signal) => {
        // Drain any remaining stream-json line.
        if (caps.outputMode === 'stream-json' && lineBuf.trim().length > 0) {
          const obj = tryParseJson(lineBuf);
          if (obj) consumeJsonObject(acc, obj);
          lineBuf = '';
        }

        const exitCode = code ?? (signal ? -1 : 1);
        const durationMs = Date.now() - start;

        if (exitCode !== 0) {
          settle(() => {
            log.error(
              { exitCode, signal, durationMs, stderr: stderrBuf.slice(-500) },
              'claude run failed',
            );
            reject(
              new ClaudeError(
                `claude exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`,
                exitCode,
                stderrBuf,
              ),
            );
          });
          return;
        }

        // Success path — derive text + sessionId based on output mode.
        const finalize = async (): Promise<ClaudeRunResult> => {
          if (caps.outputMode === 'stream-json') {
            if (acc.resultIsError) {
              throw new ClaudeError(
                `claude returned error result: ${acc.resultText || '(no result text)'}`,
                exitCode,
                stderrBuf,
              );
            }
            const rawText = acc.resultText || acc.assistantTextFallback;
            if (!rawText) {
              throw new ClaudeError(
                'claude run produced no assistant text',
                exitCode,
                stderrBuf,
              );
            }
            if (!acc.sessionId) {
              // Fall back to filesystem lookup.
              acc.sessionId = await lookupLatestSessionId(opts.cwd, engineHome);
            }
            const { text, artifacts } = extractArtifacts(rawText);
            return {
              text,
              sessionId: acc.sessionId,
              durationMs,
              exitCode,
              artifacts,
              contextWindowUsed: acc.contextWindowUsed,
              contextWindowMax: acc.contextWindowMax,
              costUsd: acc.costUsd,
              model: acc.model,
              rateLimits: acc.rateLimits,
            };
          }
          if (caps.outputMode === 'json') {
            const obj = tryParseJson(stdoutTextBuf) ?? {};
            const isError = obj.subtype === 'error' || obj.is_error === true;
            if (isError) {
              throw new ClaudeError(
                `claude returned error result: ${obj.result || '(no result text)'}`,
                exitCode,
                stderrBuf,
              );
            }
            const rawText = typeof obj.result === 'string' ? obj.result : '';
            if (!rawText) {
              throw new ClaudeError(
                'claude json output had no result field',
                exitCode,
                stderrBuf,
              );
            }
            const sessionId = obj.session_id || (await lookupLatestSessionId(opts.cwd, engineHome));
            const { text, artifacts } = extractArtifacts(rawText);
            return { text, sessionId, durationMs, exitCode, artifacts, contextWindowUsed: 0, contextWindowMax: 0, costUsd: 0 };
          }
          // text mode
          const rawText = stdoutTextBuf.trim();
          if (!rawText) {
            throw new ClaudeError(
              'claude text output was empty',
              exitCode,
              stderrBuf,
            );
          }
          const sessionId = await lookupLatestSessionId(opts.cwd, engineHome);
          const { text, artifacts } = extractArtifacts(rawText);
          return { text, sessionId, durationMs, exitCode, artifacts, contextWindowUsed: 0, contextWindowMax: 0, costUsd: 0 };
        };

        finalize().then(
          (result) => {
            settle(() => {
              log.info(
                {
                  durationMs: result.durationMs,
                  sessionId: result.sessionId,
                  textLen: result.text.length,
                  resumed: Boolean(opts.resume),
                },
                'claude run ok',
              );
              resolve(result);
            });
          },
          (err: unknown) => {
            settle(() => {
              const e =
                err instanceof ClaudeError
                  ? err
                  : new ClaudeError(
                      `claude run post-processing failed: ${(err as Error).message}`,
                      exitCode,
                      stderrBuf,
                    );
              log.error(
                { err: e.message, exitCode: e.exitCode, durationMs },
                'claude run finalize failed',
              );
              reject(e);
            });
          },
        );
      });
    });
  })();
}
