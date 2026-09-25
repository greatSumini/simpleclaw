import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Artifact, extractArtifacts } from './artifact.js';
import { log } from './log.js';

export interface CodexRunOptions {
  /** Working directory for the codex session */
  cwd: string;
  /** User message — sent via stdin */
  prompt: string;
  /** Session ID to resume. Omit for a fresh session. */
  resume?: string;
  /** Additional system-style instructions. Appended after the prompt with a "---" separator. */
  systemAppend?: string;
  /** Override model (e.g. 'o3', 'gpt-4o'). Defaults to CLI's configured model. */
  model?: string;
  /** Cancellation. Default: none. */
  signal?: AbortSignal;
  /** Hard timeout in ms. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Extra env vars for the engine process (e.g. SIMPLECLAW_RUN_TOKEN for claw-job). */
  env?: Record<string, string>;
}

export interface CodexRunResult {
  /** The assistant's final reply text. */
  text: string;
  /** Session ID for the next resume. */
  sessionId: string;
  /** Wall-clock duration. */
  durationMs: number;
  /** codex process exit code (0 on success). */
  exitCode: number;
  /** Parsed artifact markers stripped from text (files to attach, URLs to link). */
  artifacts: Artifact[];
  /** Always 0 — codex does not expose context window usage. */
  contextWindowUsed: number;
  /** Always 0 — codex does not expose context window size. */
  contextWindowMax: number;
  /** Always 0 — codex does not expose cost. */
  costUsd: number;
  /** Never set — the claude model aliases don't apply to codex. */
  model?: undefined;
  /** Never set — codex does not expose Claude subscription quota. */
  rateLimits?: undefined;
}

export class CodexError extends Error {
  exitCode: number;
  stderr: string;
  constructor(msg: string, exitCode: number, stderr: string) {
    super(msg);
    this.name = 'CodexError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 600_000;
const SIGKILL_GRACE_MS = 5_000;

function getCodexBin(): string {
  return process.env['CODEX_BIN'] ?? 'codex';
}

function buildPrompt(prompt: string, systemAppend: string | undefined): string {
  if (systemAppend?.length) {
    return `${prompt}\n\n---\n${systemAppend}`;
  }
  return prompt;
}

function buildArgs(opts: CodexRunOptions): string[] {
  // 'exec' subcommand runs codex non-interactively.
  // '--json' emits JSONL to stdout.
  // '--danger-full-access' bypasses sandbox (equivalent to claude's --dangerously-skip-permissions).
  // '-' tells codex to read the prompt from stdin.
  const args: string[] = ['exec', '--json', '--sandbox', 'danger-full-access'];
  if (opts.resume) {
    args.push('--session-id', opts.resume);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  args.push('-');
  return args;
}

// codex exec --json event shapes (subset we care about)
interface CodexEvent {
  type?: string;
  item?: {
    id?: string;
    // 'assistant_message' | 'agent_message' (both observed in docs)
    item_type?: string;
    type?: string;
    text?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
  // session_summary (legacy) or session_meta (v0.130+)
  session_id?: string;
  payload?: { id?: string };
  rollout_path?: string;
}

function tryParseJson(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    return null;
  }
}

function extractItemText(event: CodexEvent): string {
  const item = event.item;
  if (!item) return '';
  // item_type field (observed format): 'assistant_message' or 'agent_message'
  const itemType = item.item_type ?? item.type ?? '';
  if (!itemType.includes('message')) return '';
  // role guard (legacy format)
  if (item.role && item.role !== 'assistant') return '';
  if (typeof item.text === 'string') return item.text;
  // legacy content array
  if (Array.isArray(item.content)) {
    return item.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
  }
  if (typeof item.content === 'string') return item.content;
  return '';
}

interface ParseAccumulator {
  sessionId: string;
  text: string;
}

function newAccumulator(): ParseAccumulator {
  return { sessionId: '', text: '' };
}

function consumeEvent(acc: ParseAccumulator, event: CodexEvent): void {
  if (event.type === 'session_summary') {
    if (event.session_id) acc.sessionId = event.session_id;
  } else if (event.type === 'session_meta') {
    // v0.130+: session ID is in payload.id
    if (event.payload?.id) acc.sessionId = event.payload.id;
  } else if (event.type === 'item.completed') {
    const t = extractItemText(event);
    if (t) acc.text += t;
  }
}

async function lookupLatestCodexSessionId(): Promise<string> {
  // Codex stores sessions in ~/.codex/sessions/ (nested: YYYY/MM/DD/rollout-*.jsonl)
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const entries = await fs.readdir(sessionsDir, { recursive: true }).catch(() => [] as string[]);
  let newest = '';
  let newestMtime = 0;
  for (const name of entries) {
    const full = path.join(sessionsDir, name as string);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    if (stat.mtimeMs > newestMtime) {
      newestMtime = stat.mtimeMs;
      newest = name as string;
    }
  }
  if (!newest) throw new Error(`no codex session files found in ${sessionsDir}`);
  // Extract UUID from filename: rollout-YYYY-MM-DDTHH-MM-SS-{uuid}.jsonl
  const basename = path.basename(newest).replace(/\.(json|jsonl)$/, '');
  const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuidMatch ? uuidMatch[1] : basename;
}

export function runCodex(opts: CodexRunOptions): Promise<CodexRunResult> {
  return (async () => {
    const start = Date.now();
    const args = buildArgs(opts);
    const stdinPayload = buildPrompt(opts.prompt, opts.systemAppend);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    log.debug(
      {
        cwd: opts.cwd,
        resume: opts.resume,
        promptLen: opts.prompt.length,
        systemAppendLen: opts.systemAppend?.length ?? 0,
      },
      'codex run start',
    );

    return await new Promise<CodexRunResult>((resolve, reject) => {
      const proc = spawn(getCodexBin(), args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const acc = newAccumulator();
      let lineBuf = '';
      let stderrBuf = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let sigkillTimer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const killHard = (): void => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        sigkillTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }, SIGKILL_GRACE_MS);
        sigkillTimer.unref();
      };

      const onAbort = (): void => {
        settle(() => {
          killHard();
          reject(new CodexError('codex run aborted', -1, stderrBuf));
        });
      };

      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return; }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      killTimer = setTimeout(() => {
        settle(() => {
          killHard();
          reject(new CodexError(`codex run exceeded timeout ${timeoutMs}ms`, -1, stderrBuf));
        });
      }, timeoutMs);
      killTimer.unref();

      proc.on('error', (err) => {
        settle(() => {
          reject(new CodexError(`failed to spawn codex: ${err.message}`, -1, stderrBuf));
        });
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString('utf8');
        let idx: number;
        while ((idx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          const event = tryParseJson(line);
          if (event) consumeEvent(acc, event);
        }
      });

      proc.stdin.on('error', (err) => {
        log.debug({ err: err.message }, 'codex stdin error');
      });

      proc.stdin.end(stdinPayload, 'utf8');

      proc.on('close', (code, signal) => {
        // Drain remaining line buffer
        if (lineBuf.trim()) {
          const event = tryParseJson(lineBuf);
          if (event) consumeEvent(acc, event);
          lineBuf = '';
        }

        const exitCode = code ?? (signal ? -1 : 1);
        const durationMs = Date.now() - start;

        if (exitCode !== 0) {
          settle(() => {
            log.error(
              { exitCode, signal, durationMs, stderr: stderrBuf.slice(-500) },
              'codex run failed',
            );
            reject(
              new CodexError(
                `codex exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`,
                exitCode,
                stderrBuf,
              ),
            );
          });
          return;
        }

        const finalize = async (): Promise<CodexRunResult> => {
          if (!acc.text) {
            throw new CodexError('codex run produced no assistant text', exitCode, stderrBuf);
          }
          const sessionId = acc.sessionId || (await lookupLatestCodexSessionId());
          const { text, artifacts } = extractArtifacts(acc.text);
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
                'codex run ok',
              );
              resolve(result);
            });
          },
          (err: unknown) => {
            settle(() => {
              const e =
                err instanceof CodexError
                  ? err
                  : new CodexError(
                      `codex run post-processing failed: ${(err as Error).message}`,
                      exitCode,
                      stderrBuf,
                    );
              log.error(
                { err: e.message, exitCode: e.exitCode, durationMs },
                'codex run finalize failed',
              );
              reject(e);
            });
          },
        );
      });
    });
  })();
}
