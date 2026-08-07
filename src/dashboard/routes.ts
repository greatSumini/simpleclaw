import type { Express, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';

import {
  listRecentEvents,
  listEventsByThread,
  countEventsByType,
  type EventRow,
} from '../state/events.js';
import { listRecentSessions, getSession, type SessionRow } from '../state/sessions.js';
import {
  getMailState,
  listSenderPolicies,
  type MailStateRow,
  type SenderPolicyRow,
} from '../state/mail.js';
import { subscribe, type BusEvent } from './event-bus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'claw_dash';
const COOKIE_MAX_AGE_SEC = 86_400;
const TZ = 'Asia/Seoul';

const PICO_CSS = 'https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css';
const HTMX_JS = 'https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js';
const HTMX_SSE = 'https://cdn.jsdelivr.net/npm/htmx-ext-sse@2.2.2/sse.min.js';

// Known accounts referenced for the Mail tab. Centralized here so the dashboard
// can render rows even before a poll has happened.
const KNOWN_ACCOUNTS: readonly string[] = [
  'greatsumini@gmail.com',
  'cursormatfia@gmail.com',
  'lead@awesome.dev',
  'sumin@vooster.ai',
];

// Event types we surface in the overview "today" stats.
const EVT_DISCORD_RX = 'discord.message.in';
const EVT_DISCORD_TX = 'discord.message.out';
const EVT_MAIL_POLL = 'mail.poll';
const EVT_MAIL_ALERT = 'mail.alert';
const EVT_CLAUDE_INVOKE = 'claude.invoke';
const EVT_ERROR = 'error';

// ---------------------------------------------------------------------------
// Helpers — HTML escaping & time formatting
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const tsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // en-CA gives "YYYY-MM-DD, HH:MM:SS" — normalize to a more compact form.
  return tsFormatter.format(d).replace(',', '');
}

/**
 * Returns ISO string of "today 00:00:00" in Asia/Seoul, expressed as UTC.
 * Used as a cutoff for "today's stats".
 */
export function startOfTodayKstIso(): string {
  // Get the current Y/M/D in Asia/Seoul, then build a UTC ISO that corresponds
  // to KST midnight (= UTC-1500 of that date... actually KST is UTC+9, so
  // KST midnight = previous-day 15:00 UTC).
  const partsFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = partsFormatter.formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  // Construct KST midnight as a Date by parsing with explicit +09:00 offset.
  const kstMidnight = new Date(`${y}-${m}-${d}T00:00:00+09:00`);
  return kstMidnight.toISOString();
}

// ---------------------------------------------------------------------------
// Helpers — Cookies & Auth
// ---------------------------------------------------------------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m && m[1] ? m[1].trim() : null;
}

function isApiPath(path: string): boolean {
  return path.startsWith('/dashboard/api/');
}

function isAuthorized(req: Request, secret: string): boolean {
  const bearer = extractBearer(req.header('authorization'));
  if (bearer && bearer === secret) return true;
  const cookies = parseCookies(req.header('cookie'));
  const cookieVal = cookies[COOKIE_NAME];
  if (cookieVal && cookieVal === secret) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Body parsing — minimal urlencoded reader so we don't need a parser middleware
// ---------------------------------------------------------------------------

async function readUrlEncodedBody(req: Request): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      // Cap at 64KB — login form is tiny.
      if (raw.length > 64 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const out: Record<string, string> = {};
      if (!raw) return resolve(out);
      const params = new URLSearchParams(raw);
      for (const [k, v] of params.entries()) out[k] = v;
      resolve(out);
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTML — layout & shared chrome
// ---------------------------------------------------------------------------

type Tab = 'overview' | 'sessions' | 'events' | 'mail';

function navHtml(active: Tab): string {
  const items: Array<[Tab, string, string]> = [
    ['overview', '/dashboard', 'Overview'],
    ['sessions', '/dashboard/sessions', 'Sessions'],
    ['events', '/dashboard/events', 'Events'],
    ['mail', '/dashboard/mail', 'Mail'],
  ];
  return `
    <nav class="claw-nav">
      <ul>
        <li><strong>claw</strong></li>
      </ul>
      <ul>
        ${items
          .map(
            ([key, href, label]) =>
              `<li><a href="${href}"${
                key === active ? ' aria-current="page"' : ''
              }>${label}</a></li>`,
          )
          .join('')}
      </ul>
    </nav>
  `;
}

function layout(opts: { title: string; active: Tab; content: string; extraHead?: string }): string {
  const { title, active, content, extraHead } = opts;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · claw</title>
    <link rel="stylesheet" href="${PICO_CSS}">
    <script src="${HTMX_JS}"></script>
    <style>
      :root { --pico-font-size: 95%; }
      .claw-nav { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
      .claw-nav ul { margin: 0; }
      .claw-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; }
      .claw-stat { padding: 1rem; border: 1px solid var(--pico-muted-border-color); border-radius: var(--pico-border-radius); }
      .claw-stat-num { font-size: 1.6rem; font-weight: 600; }
      .claw-stat-label { font-size: 0.8rem; color: var(--pico-muted-color); text-transform: uppercase; letter-spacing: 0.05em; }
      .claw-mono { font-family: var(--pico-font-family-monospace); font-size: 0.85rem; }
      .claw-truncate { display: inline-block; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
      .claw-event-row { padding: 0.5rem 0; border-bottom: 1px solid var(--pico-muted-border-color); }
      .claw-event-row:last-child { border-bottom: none; }
      .claw-tag { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.3rem; font-size: 0.75rem; background: var(--pico-secondary-background); color: var(--pico-secondary-inverse); margin-right: 0.4rem; }
      .claw-empty { color: var(--pico-muted-color); font-style: italic; padding: 1rem 0; }
      table { font-size: 0.9rem; }
      th, td { padding: 0.4rem 0.6rem !important; }
      .claw-filters { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: end; margin-bottom: 1rem; }
      .claw-filters > * { margin: 0 !important; }
      .claw-filters label { display: block; font-size: 0.75rem; text-transform: uppercase; color: var(--pico-muted-color); }
      .claw-feed { max-height: 70vh; overflow-y: auto; padding: 0.5rem; border: 1px solid var(--pico-muted-border-color); border-radius: var(--pico-border-radius); }
    </style>
    ${extraHead ?? ''}
  </head>
  <body>
    <main class="container">
      ${navHtml(active)}
      <h2>${escapeHtml(title)}</h2>
      ${content}
      <footer style="margin-top: 2rem; font-size: 0.8rem; color: var(--pico-muted-color);">
        claw · ${escapeHtml(TZ)} · rendered ${escapeHtml(fmtTs(new Date().toISOString()))}
      </footer>
    </main>
  </body>
</html>`;
}

function loginPageHtml(opts: { error?: string; next?: string }): string {
  const error = opts.error ? `<p style="color: var(--pico-color-red-500);">${escapeHtml(opts.error)}</p>` : '';
  const next = opts.next ? `<input type="hidden" name="next" value="${escapeHtml(opts.next)}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in · claw</title>
    <link rel="stylesheet" href="${PICO_CSS}">
  </head>
  <body>
    <main class="container" style="max-width: 28rem;">
      <h2>claw dashboard</h2>
      <p>Enter the dashboard secret to continue.</p>
      ${error}
      <form method="post" action="/dashboard/login">
        ${next}
        <label>
          Secret
          <input type="password" name="secret" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Page renderers
// ---------------------------------------------------------------------------

interface OverviewData {
  todayKstIso: string;
  stats: {
    discordIn: number;
    discordOut: number;
    mailPolls: number;
    mailAlerts: number;
    claudeInvocations: number;
    claudeSeconds: number;
    errors: number;
  };
  activeSessions: number;
  recentEvents: EventRow[];
}

function gatherOverview(db: Database.Database): OverviewData {
  const sinceIso = startOfTodayKstIso();
  const stats = {
    discordIn: countEventsByType(db, EVT_DISCORD_RX, sinceIso),
    discordOut: countEventsByType(db, EVT_DISCORD_TX, sinceIso),
    mailPolls: countEventsByType(db, EVT_MAIL_POLL, sinceIso),
    mailAlerts: countEventsByType(db, EVT_MAIL_ALERT, sinceIso),
    claudeInvocations: countEventsByType(db, EVT_CLAUDE_INVOKE, sinceIso),
    claudeSeconds: sumClaudeSeconds(db, sinceIso),
    errors: countEventsByType(db, EVT_ERROR, sinceIso),
  };

  const allRecent = listRecentSessions(db, 200);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const activeSessions = allRecent.filter((s) => {
    const t = new Date(s.updatedAt).getTime();
    return Number.isFinite(t) && t >= dayAgo;
  }).length;

  const recentEvents = listRecentEvents(db, 30);

  return { todayKstIso: sinceIso, stats, activeSessions, recentEvents };
}

/**
 * Sums duration_seconds from claude.invoke event meta. Tolerant of missing/malformed meta.
 */
function sumClaudeSeconds(db: Database.Database, sinceIso: string): number {
  const stmt = db.prepare<[string, string], { meta_json: string | null }>(
    `SELECT meta_json FROM events WHERE type = ? AND ts >= ?`,
  );
  const rows = stmt.all(EVT_CLAUDE_INVOKE, sinceIso);
  let total = 0;
  for (const row of rows) {
    if (!row.meta_json) continue;
    try {
      const meta = JSON.parse(row.meta_json) as { duration_seconds?: unknown; durationSeconds?: unknown };
      const v = meta.duration_seconds ?? meta.durationSeconds;
      if (typeof v === 'number' && Number.isFinite(v)) {
        total += v;
      }
    } catch {
      // ignore unparseable meta
    }
  }
  return Math.round(total);
}

function renderOverview(data: OverviewData): string {
  const s = data.stats;
  const stat = (n: number | string, label: string) => `
    <div class="claw-stat">
      <div class="claw-stat-num">${escapeHtml(String(n))}</div>
      <div class="claw-stat-label">${escapeHtml(label)}</div>
    </div>`;

  const events =
    data.recentEvents.length === 0
      ? `<p class="claw-empty">No events yet.</p>`
      : data.recentEvents.map(renderEventRow).join('');

  return `
    <article>
      <h3>Today (${escapeHtml(TZ)})</h3>
      <div class="claw-stats">
        ${stat(s.discordIn, 'Discord in')}
        ${stat(s.discordOut, 'Discord out')}
        ${stat(s.mailPolls, 'Mail polls')}
        ${stat(s.mailAlerts, 'Mail alerts')}
        ${stat(s.claudeInvocations, 'Claude calls')}
        ${stat(`${s.claudeSeconds}s`, 'Claude time')}
        ${stat(s.errors, 'Errors')}
        ${stat(data.activeSessions, 'Active sessions (24h)')}
      </div>
    </article>
    <article>
      <h3>Recent events</h3>
      <div>${events}</div>
      <p><a href="/dashboard/events">See all events &rarr;</a></p>
    </article>
  `;
}

function renderEventRow(ev: EventRow): string {
  const tagParts: string[] = [`<span class="claw-tag">${escapeHtml(ev.type)}</span>`];
  if (ev.channel) tagParts.push(`<span class="claw-tag">#${escapeHtml(ev.channel)}</span>`);
  if (ev.threadId) {
    tagParts.push(
      `<span class="claw-tag"><a href="/dashboard/sessions/${encodeURIComponent(
        ev.threadId,
      )}">thread:${escapeHtml(ev.threadId.slice(0, 10))}</a></span>`,
    );
  }
  return `
    <div class="claw-event-row">
      <div class="claw-mono" style="color: var(--pico-muted-color); font-size: 0.78rem;">${escapeHtml(
        fmtTs(ev.ts),
      )}</div>
      <div>${tagParts.join(' ')}</div>
      <div>${escapeHtml(ev.summary)}</div>
    </div>`;
}

function renderSessionsList(rows: SessionRow[]): string {
  if (rows.length === 0) return `<p class="claw-empty">No sessions yet.</p>`;
  const tbody = rows
    .map((r) => {
      const trunc = r.claudeSessionId ? r.claudeSessionId.slice(0, 12) : '—';
      return `
        <tr>
          <td><a href="/dashboard/sessions/${encodeURIComponent(r.threadId)}"><span class="claw-mono">${escapeHtml(
            r.threadId,
          )}</span></a></td>
          <td>${escapeHtml(r.repo)}</td>
          <td><span class="claw-mono" title="${escapeHtml(r.claudeSessionId)}">${escapeHtml(trunc)}</span></td>
          <td>${escapeHtml(fmtTs(r.updatedAt))}</td>
          <td><a href="/dashboard/sessions/${encodeURIComponent(r.threadId)}">view</a></td>
        </tr>`;
    })
    .join('');
  return `
    <figure>
      <table role="grid">
        <thead>
          <tr>
            <th>thread_id</th>
            <th>repo</th>
            <th>claude_session</th>
            <th>updated_at</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </figure>`;
}

function renderSessionDetail(session: SessionRow, events: EventRow[]): string {
  // Best-effort transcript path — display only, no file serving.
  const transcriptPath = session.claudeSessionId
    ? `~/.claude/projects/<project-hash>/${session.claudeSessionId}.jsonl`
    : '—';

  const eventBlocks =
    events.length === 0
      ? `<p class="claw-empty">No events for this thread.</p>`
      : events.map(renderEventRow).join('');

  return `
    <article>
      <header><strong>${escapeHtml(session.threadId)}</strong></header>
      <dl style="display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; margin-bottom: 0;">
        <dt>repo</dt><dd>${escapeHtml(session.repo)}</dd>
        <dt>cwd</dt><dd class="claw-mono">${escapeHtml(session.cwd)}</dd>
        <dt>claude_session_id</dt><dd class="claw-mono">${escapeHtml(session.claudeSessionId)}</dd>
        <dt>created_at</dt><dd>${escapeHtml(fmtTs(session.createdAt))}</dd>
        <dt>updated_at</dt><dd>${escapeHtml(fmtTs(session.updatedAt))}</dd>
        <dt>transcript</dt><dd class="claw-mono">${escapeHtml(transcriptPath)}</dd>
      </dl>
    </article>
    <article>
      <h3>Events (${events.length})</h3>
      <div>${eventBlocks}</div>
    </article>
    <p><a href="/dashboard/sessions">&larr; back to sessions</a></p>
  `;
}

function renderEventsPage(events: EventRow[], filterTypes: string[], filterChannels: string[]): string {
  const typeOptions = ['', ...filterTypes]
    .map((t) => `<option value="${escapeHtml(t)}">${t ? escapeHtml(t) : 'any'}</option>`)
    .join('');
  const channelOptions = ['', ...filterChannels]
    .map((c) => `<option value="${escapeHtml(c)}">${c ? escapeHtml(c) : 'any'}</option>`)
    .join('');

  const initial =
    events.length === 0 ? `<p class="claw-empty">No events yet.</p>` : events.map(renderEventRow).join('');

  return `
    <p>Live event feed. New events stream in via SSE.</p>
    <form class="claw-filters" id="claw-events-filters" onsubmit="event.preventDefault();">
      <div>
        <label for="f-type">type</label>
        <select id="f-type">${typeOptions}</select>
      </div>
      <div>
        <label for="f-channel">channel</label>
        <select id="f-channel">${channelOptions}</select>
      </div>
      <div>
        <label for="f-thread">thread_id contains</label>
        <input type="text" id="f-thread" placeholder="">
      </div>
      <div>
        <button type="button" id="f-clear" class="secondary">Clear</button>
      </div>
    </form>

    <div hx-ext="sse" sse-connect="/dashboard/events/stream" sse-swap="event" hx-swap="afterbegin" class="claw-feed" id="claw-feed">
      ${initial}
    </div>

    <script>
      (function () {
        var feed = document.getElementById('claw-feed');
        var fType = document.getElementById('f-type');
        var fChan = document.getElementById('f-channel');
        var fThr  = document.getElementById('f-thread');
        var fClear = document.getElementById('f-clear');

        function applyFilters() {
          var t = fType.value || '';
          var c = fChan.value || '';
          var thr = (fThr.value || '').trim().toLowerCase();
          var rows = feed.querySelectorAll('.claw-event-row');
          rows.forEach(function (row) {
            var rt = row.getAttribute('data-type') || '';
            var rc = row.getAttribute('data-channel') || '';
            var rthr = (row.getAttribute('data-thread') || '').toLowerCase();
            var ok = true;
            if (t && rt !== t) ok = false;
            if (ok && c && rc !== c) ok = false;
            if (ok && thr && rthr.indexOf(thr) === -1) ok = false;
            row.style.display = ok ? '' : 'none';
          });
        }

        [fType, fChan, fThr].forEach(function (el) {
          el.addEventListener('input', applyFilters);
          el.addEventListener('change', applyFilters);
        });
        fClear.addEventListener('click', function () {
          fType.value = '';
          fChan.value = '';
          fThr.value = '';
          applyFilters();
        });
        // Re-apply filter after htmx swaps in new SSE rows.
        document.body.addEventListener('htmx:afterSwap', applyFilters);
      })();
    </script>

    <script src="${HTMX_SSE}"></script>
  `;
}

function renderMailPage(states: MailStateRow[], policies: SenderPolicyRow[], todayCounts: Record<string, number>, totalCounts: Record<string, number>): string {
  const rows =
    KNOWN_ACCOUNTS.length === 0
      ? `<p class="claw-empty">No accounts configured.</p>`
      : `
        <figure>
          <table role="grid">
            <thead>
              <tr>
                <th>account</th>
                <th>last_history_id</th>
                <th>last_polled_at</th>
                <th>alerts today</th>
                <th>alerts total</th>
              </tr>
            </thead>
            <tbody>
              ${KNOWN_ACCOUNTS.map((account) => {
                const st = states.find((s) => s.account === account);
                const today = todayCounts[account] ?? 0;
                const total = totalCounts[account] ?? 0;
                return `
                  <tr>
                    <td>${escapeHtml(account)}</td>
                    <td><span class="claw-mono">${escapeHtml(st?.lastHistoryId ?? '—')}</span></td>
                    <td>${escapeHtml(fmtTs(st?.lastPolledAt))}</td>
                    <td>${today}</td>
                    <td>${total}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </figure>`;

  const policyTable =
    policies.length === 0
      ? `<p class="claw-empty">No sender policies set.</p>`
      : `
        <figure>
          <table role="grid">
            <thead>
              <tr>
                <th>email</th>
                <th>account</th>
                <th>policy</th>
                <th>reason</th>
                <th>updated_at</th>
              </tr>
            </thead>
            <tbody>
              ${policies
                .map(
                  (p) => `
                    <tr>
                      <td>${escapeHtml(p.email)}</td>
                      <td>${escapeHtml(p.account)}</td>
                      <td><span class="claw-tag">${escapeHtml(p.policy)}</span></td>
                      <td>${escapeHtml(p.reason ?? '')}</td>
                      <td>${escapeHtml(fmtTs(p.updatedAt))}</td>
                    </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </figure>`;

  return `
    <article>
      <h3>Accounts</h3>
      ${rows}
    </article>
    <article>
      <h3>Sender policies</h3>
      <p style="color: var(--pico-muted-color); font-size: 0.85rem;">Read-only in v1. Edits land in a future iteration.</p>
      ${policyTable}
    </article>
  `;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface MountDashboardOpts {
  db: Database.Database;
  secret: string;
}

export function mountDashboard(app: Express, opts: MountDashboardOpts): void {
  if (!opts || !opts.db) throw new Error('mountDashboard: opts.db is required');
  if (!opts.secret) throw new Error('mountDashboard: opts.secret is required');
  const { db, secret } = opts;

  // ---- Auth guard for /dashboard/* (excluding the login routes themselves)
  const authGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/dashboard/login') {
      next();
      return;
    }
    if (isAuthorized(req, secret)) {
      next();
      return;
    }
    if (isApiPath(req.path)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // For HTML routes, redirect to login (preserve next).
    const next_ = encodeURIComponent(req.originalUrl || req.url || '/dashboard');
    res.redirect(302, `/dashboard/login?next=${next_}`);
  };

  app.use((req, res, next) => {
    if (!req.path.startsWith('/dashboard')) {
      next();
      return;
    }
    authGuard(req, res, next);
  });

  // ---- GET /dashboard/login
  app.get('/dashboard/login', (req, res) => {
    if (isAuthorized(req, secret)) {
      const next_ = typeof req.query.next === 'string' ? req.query.next : '/dashboard';
      res.redirect(302, next_);
      return;
    }
    const nextRaw = typeof req.query.next === 'string' ? req.query.next : undefined;
    res.status(200).type('html').send(loginPageHtml({ next: nextRaw }));
  });

  // ---- POST /dashboard/login
  app.post('/dashboard/login', async (req, res) => {
    let body: Record<string, string>;
    try {
      body = await readUrlEncodedBody(req);
    } catch {
      res.status(400).type('html').send(loginPageHtml({ error: 'invalid request body' }));
      return;
    }
    const provided = body.secret ?? '';
    const next_ = body.next && body.next.startsWith('/dashboard') ? body.next : '/dashboard';

    if (!provided || provided !== secret) {
      res.status(401).type('html').send(loginPageHtml({ error: 'invalid secret', next: next_ }));
      return;
    }

    // Set HTTP-only cookie scoped to /dashboard.
    const cookie = [
      `${COOKIE_NAME}=${encodeURIComponent(secret)}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/dashboard',
      `Max-Age=${COOKIE_MAX_AGE_SEC}`,
    ].join('; ');
    res.setHeader('Set-Cookie', cookie);

    // If the request looks like a normal browser form submit, redirect.
    // For programmatic clients (smoke test), allow ?json=1 or Accept: application/json
    // to receive a JSON response with 200.
    const wantsJson =
      req.query.json === '1' ||
      (typeof req.headers.accept === 'string' && req.headers.accept.includes('application/json'));
    if (wantsJson) {
      res.status(200).json({ ok: true, next: next_ });
      return;
    }
    res.redirect(302, next_);
  });

  // ---- GET /dashboard — Overview
  app.get('/dashboard', (_req, res) => {
    const data = gatherOverview(db);
    const html = layout({ title: 'Overview', active: 'overview', content: renderOverview(data) });
    res.status(200).type('html').send(html);
  });

  // ---- GET /dashboard/sessions
  app.get('/dashboard/sessions', (_req, res) => {
    const sessions = listRecentSessions(db, 50);
    const html = layout({
      title: 'Sessions',
      active: 'sessions',
      content: renderSessionsList(sessions),
    });
    res.status(200).type('html').send(html);
  });

  // ---- GET /dashboard/sessions/:threadId
  app.get('/dashboard/sessions/:threadId', (req, res) => {
    const threadId = req.params.threadId;
    const session = getSession(db, threadId);
    if (!session) {
      const html = layout({
        title: 'Session not found',
        active: 'sessions',
        content: `<p class="claw-empty">No session for thread <span class="claw-mono">${escapeHtml(
          threadId,
        )}</span>.</p><p><a href="/dashboard/sessions">&larr; back</a></p>`,
      });
      res.status(404).type('html').send(html);
      return;
    }
    const events = listEventsByThread(db, threadId, 500);
    const html = layout({
      title: `Session ${threadId}`,
      active: 'sessions',
      content: renderSessionDetail(session, events),
    });
    res.status(200).type('html').send(html);
  });

  // ---- GET /dashboard/events
  app.get('/dashboard/events', (_req, res) => {
    const events = listRecentEvents(db, 100);

    // Build dropdown values from the recent events.
    const typeSet = new Set<string>();
    const chanSet = new Set<string>();
    for (const e of events) {
      typeSet.add(e.type);
      if (e.channel) chanSet.add(e.channel);
    }
    const types = [...typeSet].sort();
    const chans = [...chanSet].sort();

    // We need to add data-attributes to event rows so the client-side filters can work.
    const eventsHtmlList = events.map(renderEventRowWithData).join('');
    const content = renderEventsPage([], types, chans).replace(
      `<div hx-ext="sse" sse-connect="/dashboard/events/stream" sse-swap="event" hx-swap="afterbegin" class="claw-feed" id="claw-feed">
      ${`<p class=\"claw-empty\">No events yet.</p>`}
    </div>`,
      `<div hx-ext="sse" sse-connect="/dashboard/events/stream" sse-swap="event" hx-swap="afterbegin" class="claw-feed" id="claw-feed">${
        events.length === 0 ? `<p class="claw-empty">No events yet.</p>` : eventsHtmlList
      }</div>`,
    );

    const html = layout({
      title: 'Events',
      active: 'events',
      content,
    });
    res.status(200).type('html').send(html);
  });

  // ---- GET /dashboard/mail
  app.get('/dashboard/mail', (_req, res) => {
    const states = KNOWN_ACCOUNTS.map((acc) => getMailState(db, acc)).filter(
      (s): s is MailStateRow => s !== null,
    );
    const policies = listSenderPolicies(db);

    const sinceIso = startOfTodayKstIso();
    const todayCounts: Record<string, number> = {};
    const totalCounts: Record<string, number> = {};
    const todayStmt = db.prepare<[string, string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE type = ? AND ts >= ? AND meta_json LIKE ?`,
    );
    const totalStmt = db.prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM events WHERE type = ? AND meta_json LIKE ?`,
    );
    for (const account of KNOWN_ACCOUNTS) {
      const like = `%"account":"${account.replace(/"/g, '\\"')}"%`;
      todayCounts[account] = todayStmt.get(EVT_MAIL_ALERT, sinceIso, like)?.c ?? 0;
      totalCounts[account] = totalStmt.get(EVT_MAIL_ALERT, like)?.c ?? 0;
    }

    const html = layout({
      title: 'Mail',
      active: 'mail',
      content: renderMailPage(states, policies, todayCounts, totalCounts),
    });
    res.status(200).type('html').send(html);
  });

  // ---- GET /dashboard/api/overview
  app.get('/dashboard/api/overview', (_req, res) => {
    const data = gatherOverview(db);
    res.status(200).json(data);
  });

  // ---- GET /dashboard/api/events
  app.get('/dashboard/api/events', (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 100;
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : '';
    const channel = typeof req.query.channel === 'string' ? req.query.channel : '';

    const all = listRecentEvents(db, Math.min(1000, limit * 4));
    const filtered = all.filter((e) => {
      if (type && e.type !== type) return false;
      if (channel && e.channel !== channel) return false;
      if (threadId && e.threadId !== threadId) return false;
      return true;
    });
    res.status(200).json(filtered.slice(0, limit));
  });

  // ---- GET /dashboard/events/stream — SSE
  app.get('/dashboard/events/stream', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Initial comment to open the stream.
    res.write(`: connected\n\n`);

    const send = (ev: BusEvent): void => {
      const html = renderEventRowWithData({
        id: 0,
        ts: ev.ts,
        type: ev.type,
        channel: ev.channel ?? null,
        threadId: ev.threadId ?? null,
        summary: ev.summary,
        metaJson: ev.metaJson ?? null,
      });
      // SSE data lines must not contain raw newlines, so prefix each line.
      const dataLines = html
        .split('\n')
        .map((l) => `data: ${l}`)
        .join('\n');
      res.write(`event: event\n${dataLines}\n\n`);
    };

    const unsubscribe = subscribe(send);

    const heartbeat = setInterval(() => {
      try {
        res.write(`event: ping\ndata: {}\n\n`);
      } catch {
        // socket likely closed; cleanup happens on close event
      }
    }, 15_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  });
}

// ---------------------------------------------------------------------------
// Event row variant with data-attributes for client-side filtering
// ---------------------------------------------------------------------------

function renderEventRowWithData(ev: EventRow): string {
  const tagParts: string[] = [`<span class="claw-tag">${escapeHtml(ev.type)}</span>`];
  if (ev.channel) tagParts.push(`<span class="claw-tag">#${escapeHtml(ev.channel)}</span>`);
  if (ev.threadId) {
    tagParts.push(
      `<span class="claw-tag"><a href="/dashboard/sessions/${encodeURIComponent(
        ev.threadId,
      )}">thread:${escapeHtml(ev.threadId.slice(0, 10))}</a></span>`,
    );
  }
  return `<div class="claw-event-row" data-type="${escapeHtml(ev.type)}" data-channel="${escapeHtml(
    ev.channel ?? '',
  )}" data-thread="${escapeHtml(ev.threadId ?? '')}"><div class="claw-mono" style="color: var(--pico-muted-color); font-size: 0.78rem;">${escapeHtml(
    fmtTs(ev.ts),
  )}</div><div>${tagParts.join(' ')}</div><div>${escapeHtml(ev.summary)}</div></div>`;
}
