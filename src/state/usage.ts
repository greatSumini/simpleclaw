import type Database from 'better-sqlite3';
import type { RateLimitSnapshot, RateLimitWindow } from '../claude.js';

export interface UsageSnapshot {
  contextWindowUsed: number;
  contextWindowMax: number;
  /** Raw `total_cost_usd` from the CLI — see ClaudeRunResult.costUsd for why it can't be summed. */
  costUsd: number;
  sessionId: string;
  /** Model that served the turn, as reported by the engine. Absent for codex/tmux runs. */
  model?: string;
  /** True when no model was configured for this channel — the CLI's own default served the turn. */
  modelIsDefault?: boolean;
  /** Account-wide quota utilization from the CLI's `rate_limit_event`. Absent for codex/tmux runs. */
  rateLimits?: RateLimitSnapshot;
}

export function logUsage(db: Database.Database, entry: UsageSnapshot): void {
  if (entry.costUsd <= 0 && entry.contextWindowUsed <= 0) return;
  db.prepare(
    `INSERT INTO usage_ledger (ts, session_id, context_window_used, context_window_max, cost_usd)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.sessionId,
    entry.contextWindowUsed,
    entry.contextWindowMax,
    entry.costUsd,
  );
}

/**
 * Trim a full model id down to what's worth reading in a footer:
 * 'claude-haiku-4-5-20251001' → 'haiku-4-5'. Unknown shapes pass through unchanged.
 */
export function shortModelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

function fmtWindow(w: RateLimitWindow | undefined, nowMs: number): string {
  if (!w) return 'n/a';
  // A reading taken before the window reset no longer describes the current window.
  if (w.resetsAt * 1000 <= nowMs) return 'n/a';
  return `${Math.round(w.utilization * 100)}%`;
}

export function buildUsageFooter(snap: UsageSnapshot, nowMs = Date.now()): string {
  let currentStr: string;
  if (snap.contextWindowMax > 0) {
    const pct = Math.round((snap.contextWindowUsed / snap.contextWindowMax) * 100);
    currentStr = `${pct}% (${fmtTokens(snap.contextWindowUsed)}/${fmtTokens(snap.contextWindowMax)})`;
  } else {
    currentStr = 'n/a';
  }
  const fiveHour = fmtWindow(snap.rateLimits?.fiveHour, nowMs);
  const weekly = fmtWindow(snap.rateLimits?.sevenDay, nowMs);
  // No model segment at all when the engine didn't report one — a 'model n/a' tells nobody anything.
  const defaultTag = snap.modelIsDefault ? ' (default)' : '';
  const modelStr = snap.model ? `model ${shortModelName(snap.model)}${defaultTag} / ` : '';
  return `[${modelStr}context usage / current ${currentStr} / 5h ${fiveHour} / weekly ${weekly}]`;
}
