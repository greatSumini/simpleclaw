import type Database from 'better-sqlite3';

export interface UsageSnapshot {
  contextWindowUsed: number;
  contextWindowMax: number;
  costUsd: number;
  sessionId: string;
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

function sumCost(db: Database.Database, since: string): number {
  return (
    (db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) FROM usage_ledger WHERE ts > ?')
      .pluck()
      .get(since) as number) ?? 0
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

export function buildUsageFooter(db: Database.Database, snap: UsageSnapshot): string {
  let currentStr: string;
  if (snap.contextWindowMax > 0) {
    const pct = Math.round((snap.contextWindowUsed / snap.contextWindowMax) * 100);
    currentStr = `${pct}% (${fmtTokens(snap.contextWindowUsed)}/${fmtTokens(snap.contextWindowMax)})`;
  } else {
    currentStr = 'n/a';
  }

  const limit5h = Number(process.env['CLAW_5H_COST_LIMIT_USD'] ?? '5');
  const cost5h = sumCost(db, new Date(Date.now() - 5 * 3_600_000).toISOString());
  const pct5h = limit5h > 0 ? Math.min(100, Math.round((cost5h / limit5h) * 100)) : 0;

  const limitWeekly = Number(process.env['CLAW_WEEKLY_COST_LIMIT_USD'] ?? '30');
  const costWeekly = sumCost(db, new Date(Date.now() - 7 * 24 * 3_600_000).toISOString());
  const pctWeekly = limitWeekly > 0 ? Math.min(100, Math.round((costWeekly / limitWeekly) * 100)) : 0;

  return `[context usage / current ${currentStr} / 5h ${pct5h}% / weekly ${pctWeekly}%]`;
}
