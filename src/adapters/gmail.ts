/**
 * Gmail adapter — polls one or more Gmail accounts for new inbox mail,
 * classifies importance via the orchestrator, and posts alerts to Discord.
 *
 * Uses Gmail's incremental `users.history.list` API: on first run we just
 * record the current historyId and skip the backlog ("start from now"),
 * then each subsequent poll fetches only what changed since.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { google, type gmail_v1 } from 'googleapis';

import type { AppConfig, GmailAccount } from '../config.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';
import {
  createMailThread,
  getMailState,
  getMailThreadByGmailMsg,
  setMailState,
} from '../state/mail.js';
import { classifyMail } from '../orchestrator/importance.js';
import type { ImportanceVerdict, MailAttachment, MailSummary } from '../orchestrator/types.js';
import { emitEvent } from '../dashboard/event-bus.js';
import type { MailAlertPoster } from '../messenger/types.js';

// Re-exported for backward compat (was a local interface here previously).
export type { MailAlertPoster as DiscordPoster };

interface GmailAdapterOpts {
  config: AppConfig;
  db: Database.Database;
  poster: MailAlertPoster;
}

interface AccountRuntime {
  account: GmailAccount;
  oauth: ReturnType<typeof makeOAuth>;
  gmail: gmail_v1.Gmail;
  /** True once we've encountered an unrecoverable error (e.g. revoked token). */
  disabled: boolean;
}

function makeOAuth(clientId: string, clientSecret: string) {
  return new google.auth.OAuth2({ clientId, clientSecret });
}

const MAIL_ALERT_CHANNEL_NAME = 'vmc-context-hub';
const BODY_TEXT_TRUNCATE = 4000;
const THREAD_NAME_MAX = 90;
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024; // Discord free-tier file size limit

/**
 * Decode a base64url-encoded string from the Gmail API.
 * Tolerates standard base64 padding mismatches.
 */
function decodeBase64Url(data: string): string {
  if (!data) return '';
  // base64url -> base64
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Crude HTML→text fallback used only when no text/plain part exists. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recursively extract plain-text content from a Gmail message payload.
 * Prefers text/plain parts; falls back to text/html stripped.
 * Truncates to BODY_TEXT_TRUNCATE chars.
 *
 * Exported for shape testing.
 */
export function extractPlainText(
  payload: gmail_v1.Schema$MessagePart | undefined | null,
): string {
  if (!payload) return '';

  const plain = collectByMime(payload, 'text/plain');
  if (plain) return truncate(plain, BODY_TEXT_TRUNCATE);

  const html = collectByMime(payload, 'text/html');
  if (html) return truncate(htmlToText(html), BODY_TEXT_TRUNCATE);

  // No mimeType match — try to grab any body data we can find.
  const fallback = collectAny(payload);
  return truncate(fallback, BODY_TEXT_TRUNCATE);
}

function collectByMime(
  part: gmail_v1.Schema$MessagePart,
  mime: string,
): string {
  const acc: string[] = [];
  walk(part, (p) => {
    if (p.mimeType === mime && p.body?.data) {
      acc.push(decodeBase64Url(p.body.data));
    }
  });
  return acc.join('\n').trim();
}

function collectAny(part: gmail_v1.Schema$MessagePart): string {
  const acc: string[] = [];
  walk(part, (p) => {
    if (p.body?.data && (!p.mimeType || p.mimeType.startsWith('text/'))) {
      acc.push(decodeBase64Url(p.body.data));
    }
  });
  return acc.join('\n').trim();
}

function walk(
  part: gmail_v1.Schema$MessagePart,
  visit: (p: gmail_v1.Schema$MessagePart) => void,
): void {
  visit(part);
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) walk(child, visit);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(이하 생략)`;
}

function getHeader(
  payload: gmail_v1.Schema$MessagePart | undefined | null,
  name: string,
): string {
  if (!payload?.headers) return '';
  const lower = name.toLowerCase();
  for (const h of payload.headers) {
    if (h.name && h.name.toLowerCase() === lower) {
      return h.value ?? '';
    }
  }
  return '';
}

/** Extract the bare email address from a "Display Name <user@host>" header. */
function extractEmail(from: string): string {
  if (!from) return '';
  const angle = from.match(/<([^>]+)>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  // No angles — assume the whole thing is an email.
  return from.trim().toLowerCase();
}

/** KST display string: YYYY-MM-DD HH:mm KST */
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
  // en-CA gives "YYYY-MM-DD, HH:mm". Normalize.
  const out = fmt.format(date).replace(', ', ' ').replace(',', ' ');
  return `${out} KST`;
}

/** Escape Discord markdown so snippets don't break formatting. */
function escapeDiscordMarkdown(s: string): string {
  return s.replace(/([*_~`>|\\])/g, '\\$1');
}

function truncateThreadName(s: string, max = THREAD_NAME_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Collect attachment metadata (parts with attachmentId) from a message payload. */
function extractAttachments(
  payload: gmail_v1.Schema$MessagePart | undefined | null,
): MailAttachment[] {
  if (!payload) return [];
  const results: MailAttachment[] = [];
  walk(payload, (p) => {
    if (p.body?.attachmentId && p.filename) {
      results.push({
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        attachmentId: p.body.attachmentId,
        size: p.body.size ?? 0,
      });
    }
  });
  return results;
}

/**
 * Classify an error as transient/retryable (network, rate-limit, 5xx) vs permanent.
 * Transient failures must NOT advance the Gmail historyId, otherwise the affected
 * messages are silently skipped forever ("will retry next cycle" never happens).
 */
function isRetryableError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; message?: string };
  const code = e.code ?? e.status;
  if (typeof code === 'number' && (code === 429 || code >= 500)) return true;
  const msg = (e.message ?? String(err)).toLowerCase();
  return (
    msg.includes('failed, reason') || // node fetch network failure (EADDRNOTAVAIL 등)
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('eaddrnotavail') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
}

export class GmailAdapter {
  private readonly config: AppConfig;
  private readonly db: Database.Database;
  private readonly poster: MailAlertPoster;
  private readonly runtimes: AccountRuntime[];
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: GmailAdapterOpts) {
    this.config = opts.config;
    this.db = opts.db;
    this.poster = opts.poster;
    this.intervalMs = Math.max(
      30_000,
      opts.config.env.MAIL_POLL_INTERVAL_SEC * 1000,
    );

    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = opts.config.env;
    this.runtimes = opts.config.gmail.map((account) => {
      const oauth = makeOAuth(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
      oauth.setCredentials({ refresh_token: account.refreshToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth });
      return { account, oauth, gmail, disabled: false };
    });
  }

  async start(): Promise<void> {
    if (this.runtimes.length === 0) {
      log.warn('gmail adapter: no accounts configured — nothing to poll');
      return;
    }
    log.info(
      { accounts: this.runtimes.length, intervalMs: this.intervalMs },
      'gmail adapter starting',
    );
    // Kick off first poll immediately and await it so callers know we're alive.
    await this.runCycle();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      // Guard: skip if previous cycle still running.
      if (this.cycleInFlight) {
        log.debug('gmail adapter: previous cycle still running, skipping tick');
        return;
      }
      void this.runCycle();
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cycleInFlight) {
      try {
        await this.cycleInFlight;
      } catch {
        // already logged inside the cycle
      }
    }
    log.info('gmail adapter stopped');
  }

  async pollOnce(
    account?: string,
  ): Promise<{ processed: number; alerted: number }> {
    let processed = 0;
    let alerted = 0;
    const targets = account
      ? this.runtimes.filter((r) => r.account.email === account)
      : this.runtimes;
    for (const rt of targets) {
      if (rt.disabled) continue;
      try {
        const r = await this.pollAccount(rt);
        processed += r.processed;
        alerted += r.alerted;
      } catch (err) {
        log.error(
          { account: rt.account.email, err: (err as Error).message },
          'gmail pollOnce: account failed',
        );
      }
    }
    return { processed, alerted };
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
    const startedAt = Date.now();
    let totalProcessed = 0;
    let totalAlerted = 0;
    let activeAccounts = 0;
    for (const rt of this.runtimes) {
      if (this.stopped) return;
      if (rt.disabled) continue;
      activeAccounts++;
      try {
        const r = await this.pollAccount(rt);
        totalProcessed += r.processed;
        totalAlerted += r.alerted;
      } catch (err) {
        // pollAccount already does most error handling, but defense in depth:
        log.error(
          { account: rt.account.email, err: (err as Error).message },
          'gmail cycle: unexpected per-account error',
        );
      }
    }
    const durationMs = Date.now() - startedAt;
    const summary = `polled ${activeAccounts} accounts: processed=${totalProcessed} alerted=${totalAlerted} (${durationMs}ms)`;
    logEvent(this.db, {
      type: 'mail.poll',
      channel: 'vmc-context-hub',
      summary,
      meta: {
        accounts: activeAccounts,
        processed: totalProcessed,
        alerted: totalAlerted,
        durationMs,
      },
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'mail.poll',
      channel: 'vmc-context-hub',
      summary,
    });
  }

  private async pollAccount(
    rt: AccountRuntime,
  ): Promise<{ processed: number; alerted: number }> {
    const { account, gmail } = rt;
    const state = getMailState(this.db, account.email);

    // Bootstrap path — no historyId yet, snapshot current and exit.
    if (!state || !state.lastHistoryId) {
      try {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const hid = profile.data.historyId;
        if (!hid) {
          log.warn(
            { account: account.email },
            'gmail bootstrap: profile returned no historyId',
          );
          return { processed: 0, alerted: 0 };
        }
        setMailState(this.db, account.email, hid);
        log.info(
          { account: account.email, historyId: hid },
          'gmail bootstrap complete (start-from-now)',
        );
        return { processed: 0, alerted: 0 };
      } catch (err) {
        return this.handleApiError(rt, err, 'bootstrap');
      }
    }

    // Incremental path.
    let historyResp;
    try {
      historyResp = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: state.lastHistoryId,
        historyTypes: ['messageAdded'],
      });
    } catch (err) {
      // 404 → history too old; re-bootstrap.
      const code = (err as { code?: number; status?: number }).code
        ?? (err as { status?: number }).status;
      if (code === 404) {
        log.warn(
          { account: account.email, lastHistoryId: state.lastHistoryId },
          'gmail history too old (404), re-bootstrapping from current profile',
        );
        try {
          const profile = await gmail.users.getProfile({ userId: 'me' });
          if (profile.data.historyId) {
            setMailState(this.db, account.email, profile.data.historyId);
          }
        } catch (bootErr) {
          log.error(
            { account: account.email, err: (bootErr as Error).message },
            'gmail re-bootstrap after 404 failed',
          );
        }
        return { processed: 0, alerted: 0 };
      }
      return this.handleApiError(rt, err, 'history.list');
    }

    const histories = historyResp.data.history ?? [];
    const newHistoryId = historyResp.data.historyId;

    // Collect message IDs that were added in this batch (dedupe).
    const addedIds = new Set<string>();
    for (const h of histories) {
      const adds = h.messagesAdded ?? [];
      for (const a of adds) {
        const id = a.message?.id;
        if (id) addedIds.add(id);
      }
    }

    let processed = 0;
    let alerted = 0;
    // If any message hits a transient failure we must NOT advance historyId past
    // it, so the next cycle re-fetches and genuinely retries it.
    let heldBack = false;

    for (const id of addedIds) {
      if (this.stopped) break;
      // Idempotency.
      const existing = getMailThreadByGmailMsg(this.db, id);
      if (existing) {
        log.debug({ account: account.email, id }, 'mail already mapped, skipping');
        continue;
      }
      try {
        const r = await this.processMessage(rt, id);
        processed += 1;
        if (r.alerted) alerted += 1;
        // Discord post failed transiently inside processMessage — hold back.
        if (r.failed) heldBack = true;
      } catch (err) {
        const errMsg = (err as Error).message ?? '';
        // Gmail returns 404 "Requested entity was not found" when a message was
        // deleted before we could fetch it. This is expected and unrecoverable —
        // skip silently rather than polluting the error log.
        if (errMsg.includes('Requested entity was not found')) {
          log.debug({ account: account.email, id }, 'gmail: message not found (deleted), skipping');
          continue;
        }
        const retryable = isRetryableError(err);
        if (retryable) {
          heldBack = true;
          log.error(
            { account: account.email, id, err: errMsg },
            'gmail: transient failure processing message, holding back historyId for retry',
          );
        } else {
          log.error(
            { account: account.email, id, err: errMsg },
            'gmail: permanent failure processing message, skipping (historyId will advance)',
          );
        }
        logEvent(this.db, {
          type: 'mail.error',
          channel: MAIL_ALERT_CHANNEL_NAME,
          summary: `process error: ${id}`,
          meta: { account: account.email, gmailMsgId: id, error: errMsg, retryable },
        });
      }
    }

    // Only advance the historyId when nothing was held back. Idempotency
    // (getMailThreadByGmailMsg) makes re-fetching already-handled messages safe.
    if (newHistoryId && !heldBack) {
      setMailState(this.db, account.email, newHistoryId);
    } else if (heldBack) {
      log.warn(
        { account: account.email, newHistoryId },
        'gmail: held back historyId advance due to transient failures — will retry next cycle',
      );
    }

    if (processed > 0 || alerted > 0) {
      log.info(
        { account: account.email, processed, alerted, newHistoryId },
        'gmail poll cycle complete',
      );
    }
    return { processed, alerted };
  }

  private async processMessage(
    rt: AccountRuntime,
    messageId: string,
  ): Promise<{ alerted: boolean; failed?: boolean }> {
    const { account, gmail } = rt;

    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const msg = detail.data;
    const labelIds = msg.labelIds ?? [];

    // Filter: must be in INBOX.
    if (!labelIds.includes('INBOX')) {
      log.debug(
        { account: account.email, id: messageId, labels: labelIds },
        'mail not in INBOX, skipping',
      );
      logEvent(this.db, {
        type: 'mail.skipped',
        channel: MAIL_ALERT_CHANNEL_NAME,
        summary: `not-inbox: ${messageId}`,
        meta: { account: account.email, gmailMsgId: messageId, reason: 'not-inbox', labels: labelIds },
      });
      return { alerted: false };
    }

    // Filter: noisy categories.
    const noisyLabels = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM', 'TRASH', 'DRAFT'];
    const noisy = labelIds.find((l) => noisyLabels.includes(l));
    if (noisy) {
      log.debug(
        { account: account.email, id: messageId, label: noisy },
        'mail in noisy category, skipping',
      );
      logEvent(this.db, {
        type: 'mail.skipped',
        channel: MAIL_ALERT_CHANNEL_NAME,
        summary: `noisy: ${messageId}`,
        meta: { account: account.email, gmailMsgId: messageId, reason: noisy },
      });
      return { alerted: false };
    }

    // Build MailSummary.
    const fromHeader = getHeader(msg.payload, 'From');
    const subject = getHeader(msg.payload, 'Subject') || '(제목 없음)';
    const fromEmail = extractEmail(fromHeader);
    let receivedIso = new Date().toISOString();
    if (msg.internalDate) {
      const ms = Number(msg.internalDate);
      if (Number.isFinite(ms)) {
        receivedIso = new Date(ms).toISOString();
      }
    }

    const mail: MailSummary = {
      account: account.email,
      messageId,
      threadId: msg.threadId ?? messageId,
      from: fromHeader,
      fromEmail,
      subject,
      receivedAtIso: receivedIso,
      snippet: msg.snippet ?? '',
      bodyText: extractPlainText(msg.payload),
      attachments: extractAttachments(msg.payload),
    };

    // Classify.
    const verdict = await classifyMail({ mail, config: this.config, db: this.db });

    if (verdict.kind === 'ignore') {
      log.info(
        { account: account.email, subject, fromEmail, reason: verdict.reason },
        'mail ignored',
      );
      // Policy-ignore: brief notice on first occurrence in 7 days so user can unignore.
      if (verdict.reason === 'sender ignore-listed' && isPolicyIgnoreFirstIn7Days(this.db, fromEmail, account.email)) {
        try {
          await this.poster.postToChannel(
            this.config.mailAlertChannelId,
            `📪 **${fromEmail}** 발신자의 메일이 도착했지만 무시 목록에 있어 건너뜁니다.\n해제하려면 이 채널에 \`무시 해제 ${fromEmail}\`를 입력하세요.`,
          );
        } catch (e) {
          log.warn({ fromEmail, err: (e as Error).message }, 'gmail: failed to post policy-ignore notice');
        }
      }
      logEvent(this.db, {
        type: 'mail.ignored',
        channel: MAIL_ALERT_CHANNEL_NAME,
        summary: subject,
        meta: { account: account.email, fromEmail, gmailMsgId: messageId, reason: verdict.reason },
      });
      return { alerted: false };
    }

    // important or ambiguous → post to Discord.
    const oneLineSummary = verdict.oneLineSummary || subject;
    const alertBody = this.buildAlertBody(verdict, mail);
    const detailBody = this.buildDetailBody(verdict, mail);
    const threadName = truncateThreadName(`📩 ${oneLineSummary}`, THREAD_NAME_MAX);

    // Download attachments to temp files (best-effort; skip on error).
    const attachmentFiles = await this.downloadAttachments(rt, mail);

    let posted: { threadId: string; firstMessageId: string };
    try {
      posted = await this.poster.postMailAlert({
        channelId: this.config.mailAlertChannelId,
        threadName,
        initialMessage: alertBody,
        threadFirstMessage: detailBody,
        attachmentFiles,
        senderEmail: mail.fromEmail,
        senderAccount: mail.account,
      });
    } catch (err) {
      log.error(
        { account: account.email, id: messageId, err: (err as Error).message },
        'gmail: discord postMailAlert failed',
      );
      logEvent(this.db, {
        type: 'mail.error',
        channel: MAIL_ALERT_CHANNEL_NAME,
        summary: `discord post failed: ${subject}`,
        meta: {
          account: account.email,
          gmailMsgId: messageId,
          error: (err as Error).message,
        },
      });
      // Transient post failure (network/5xx/429) → hold back historyId so the
      // alert is retried; permanent failures (e.g. 400) advance to avoid a poison pill.
      return { alerted: false, failed: isRetryableError(err) };
    }

    createMailThread(this.db, {
      discordThreadId: posted.threadId,
      discordMessageId: posted.firstMessageId,
      gmailMsgId: mail.messageId,
      gmailThreadId: mail.threadId,
      account: mail.account,
      subject: mail.subject,
      status: 'awaiting_user',
    });

    const evtMeta = {
      account: account.email,
      gmailMsgId: mail.messageId,
      gmailThreadId: mail.threadId,
      verdict: verdict.kind,
      fromEmail,
    };
    logEvent(this.db, {
      type: 'mail.alert',
      channel: MAIL_ALERT_CHANNEL_NAME,
      threadId: posted.threadId,
      summary: oneLineSummary,
      meta: evtMeta,
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'mail.alert',
      channel: MAIL_ALERT_CHANNEL_NAME,
      threadId: posted.threadId,
      summary: oneLineSummary,
      metaJson: JSON.stringify(evtMeta),
    });

    return { alerted: true };
  }

  /** Short 2–3 line channel notification. */
  private buildAlertBody(
    verdict: Exclude<ImportanceVerdict, { kind: 'ignore' }>,
    mail: MailSummary,
  ): string {
    const ownerUserId = this.config.env.DISCORD_OWNER_USER_ID;
    const accountLabel = this.findAccountLabel(mail.account);
    const ts = formatKst(mail.receivedAtIso);
    const fromDisplay = mail.from || mail.fromEmail || '(unknown)';

    if (verdict.kind === 'important') {
      const oneLine = verdict.oneLineSummary || mail.subject || '(제목 없음)';
      return [
        `**[중요] ${oneLine}** <@${ownerUserId}>`,
        `📩 ${accountLabel} | 👤 ${escapeDiscordMarkdown(fromDisplay)} | 📅 ${ts}`,
        '진행할까요? (예 / 아니오 / 다른 방향 / 이 발신자 무시)',
      ].join('\n');
    }

    // ambiguous
    return [
      `**[모호] ${verdict.oneLineSummary || '중요·긴급 여부 확인 부탁'}** <@${ownerUserId}>`,
      `📩 ${accountLabel} | 👤 ${escapeDiscordMarkdown(fromDisplay)} | 📅 ${ts}`,
      '[a] 중요/긴급 [b] 정보성 [c] 이 발신자 무시',
    ].join('\n');
  }

  /** Full detail message posted as first thread message. */
  private buildDetailBody(
    verdict: Exclude<ImportanceVerdict, { kind: 'ignore' }>,
    mail: MailSummary,
  ): string {
    const subject = mail.subject || '(제목 없음)';
    const body = (mail.bodyText ?? '').trim() || '(본문 없음)';
    const lines: string[] = [`📝 **제목**: ${subject}`];

    if (verdict.kind === 'important') {
      if (verdict.contextNotes) {
        lines.push(`🧭 **맥락**: ${verdict.contextNotes}`);
      }
      const actions =
        verdict.suggestedActions.length > 0
          ? verdict.suggestedActions.map((a, i) => `${i + 1}. ${a}`).join(' / ')
          : '내용 확인 후 답장';
      lines.push(`🛠️ **제안**: ${actions}`);
    } else {
      lines.push(`🤔 **모호한 이유**: ${verdict.reason}`);
    }

    lines.push('', '```', body, '```');
    return lines.join('\n');
  }

  /** Download attachments from Gmail API to a temp dir. Returns local file infos. */
  private async downloadAttachments(
    rt: AccountRuntime,
    mail: MailSummary,
  ): Promise<{ path: string; filename: string }[]> {
    const attachments = mail.attachments ?? [];
    if (attachments.length === 0) return [];

    let tmpDir: string;
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-mail-'));
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'gmail: failed to create temp dir for attachments');
      return [];
    }

    const results: { path: string; filename: string }[] = [];
    for (const att of attachments) {
      if (att.size > ATTACHMENT_MAX_BYTES) {
        log.info(
          { filename: att.filename, size: att.size },
          'gmail: attachment too large for Discord, skipping',
        );
        continue;
      }
      try {
        const res = await rt.gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: mail.messageId,
          id: att.attachmentId,
        });
        const data = res.data.data ?? '';
        const buf = Buffer.from(
          data.replace(/-/g, '+').replace(/_/g, '/'),
          'base64',
        );
        const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(tmpDir, safeName);
        await fs.writeFile(filePath, buf);
        results.push({ path: filePath, filename: att.filename });
      } catch (err) {
        log.warn(
          { filename: att.filename, err: (err as Error).message },
          'gmail: failed to download attachment, skipping',
        );
      }
    }
    return results;
  }

  private findAccountLabel(email: string): string {
    const acc = this.config.gmail.find((a) => a.email === email);
    return acc?.label ?? email;
  }

  private handleApiError(
    rt: AccountRuntime,
    err: unknown,
    op: string,
  ): { processed: number; alerted: number } {
    const code = (err as { code?: number; status?: number }).code
      ?? (err as { status?: number }).status;
    const message = (err as Error).message ?? String(err);

    if (code === 401) {
      log.error(
        { account: rt.account.email, op, code, err: message },
        'gmail 401: refresh token revoked, disabling account',
      );
      rt.disabled = true;
      logEvent(this.db, {
        type: 'mail.error',
        channel: MAIL_ALERT_CHANNEL_NAME,
        summary: `auth revoked: ${rt.account.email}`,
        meta: { account: rt.account.email, op, code, error: message },
      });
      return { processed: 0, alerted: 0 };
    }

    log.error(
      { account: rt.account.email, op, code, err: message },
      'gmail api error, will retry next cycle',
    );
    return { processed: 0, alerted: 0 };
  }
}

// Returns true if there is no prior mail.ignored event for (fromEmail, account) in the last 7 days.
// Used to rate-limit policy-ignore notices so the user isn't spammed.
function isPolicyIgnoreFirstIn7Days(db: Database.Database, fromEmail: string, account: string): boolean {
  const stmt = db.prepare<[string, string], { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM events
     WHERE type = 'mail.ignored'
       AND json_extract(meta_json, '$.fromEmail') = ?
       AND json_extract(meta_json, '$.account') = ?
       AND ts >= datetime('now', '-7 days')`,
  );
  const row = stmt.get(fromEmail, account);
  return (row?.cnt ?? 0) === 0;
}
