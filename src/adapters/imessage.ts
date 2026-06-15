/**
 * iMessage adapter — polls ~/Library/Messages/chat.db for new incoming messages,
 * classifies importance, and posts alerts to Discord.
 *
 * Requirements:
 *   - macOS only
 *   - The process (or Terminal.app / launchctl service) must have "Full Disk Access"
 *     granted in System Settings > Privacy & Security > Full Disk Access
 *   - Set IMESSAGE_ENABLED=true in .env to activate
 */

import SqliteDB from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

import type BetterSqliteDatabase from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';
import { emitEvent } from '../dashboard/event-bus.js';
import { getImessageState, setImessageState } from '../state/imessage.js';
import { classifyMail } from '../orchestrator/importance.js';
import type { ImportanceVerdict, MailSummary } from '../orchestrator/types.js';
import type { MailAlertPoster } from '../messenger/types.js';

// Apple's reference epoch: Jan 1, 2001 00:00:00 UTC in Unix seconds
const APPLE_EPOCH_OFFSET_SEC = 978307200;

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const IMESSAGE_ACCOUNT = 'imessage';
const ALERT_CHANNEL = 'vmc-context-hub';
const THREAD_NAME_MAX = 90;
const POLL_BATCH = 100;

interface IMessageAdapterOpts {
  config: AppConfig;
  db: BetterSqliteDatabase.Database;
  poster: MailAlertPoster;
}

interface RawMessageRow {
  rowid: number;
  text: string | null;
  date: number;         // Apple epoch nanoseconds
  handle_id: string;   // sender phone/email from handle.id
  chat_id: string;     // chat.chat_identifier
  display_name: string | null;  // non-null for group chats
}

export class IMessageAdapter {
  private readonly config: AppConfig;
  private readonly db: BetterSqliteDatabase.Database;
  private readonly poster: MailAlertPoster;
  private readonly intervalMs: number;

  private chatDb: BetterSqliteDatabase.Database | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: IMessageAdapterOpts) {
    this.config = opts.config;
    this.db = opts.db;
    this.poster = opts.poster;
    this.intervalMs = Math.max(30_000, opts.config.env.IMESSAGE_POLL_INTERVAL_SEC * 1000);
  }

  async start(): Promise<void> {
    try {
      this.chatDb = new SqliteDB(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    } catch (err) {
      log.error(
        { err: (err as Error).message, path: CHAT_DB_PATH },
        'imessage adapter: chat.db 열기 실패 — 시스템 환경설정 > 개인 정보 보호 > 전체 디스크 접근 권한을 확인하세요',
      );
      return;
    }
    log.info({ intervalMs: this.intervalMs }, 'imessage adapter starting');
    await this.runCycle();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      if (this.cycleInFlight) return;
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
      try { await this.cycleInFlight; } catch { /* already logged */ }
    }
    this.chatDb?.close();
    this.chatDb = null;
    log.info('imessage adapter stopped');
  }

  // ---------- internals ----------

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight) return;
    const p = this.doCycle().finally(() => { this.cycleInFlight = null; });
    this.cycleInFlight = p;
    await p;
  }

  private async doCycle(): Promise<void> {
    if (!this.chatDb) return;

    const state = getImessageState(this.db);
    const lastRowId = state?.lastRowId ?? 0;

    let rows: RawMessageRow[];
    try {
      rows = this.fetchNewMessages(lastRowId);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'imessage: chat.db 쿼리 실패');
      return;
    }

    if (rows.length === 0) return;

    let maxRowId = lastRowId;
    let processed = 0;
    let alerted = 0;

    for (const row of rows) {
      if (this.stopped) break;
      if (row.rowid > maxRowId) maxRowId = row.rowid;

      const text = (row.text ?? '').trim();
      if (!text) continue; // 첨부파일만 있는 메시지 건너뜀

      try {
        const r = await this.processMessage(row, text);
        processed++;
        if (r.alerted) alerted++;
      } catch (err) {
        log.error({ err: (err as Error).message, rowid: row.rowid }, 'imessage: 메시지 처리 실패');
      }
    }

    if (maxRowId > lastRowId) {
      setImessageState(this.db, maxRowId);
    }

    const summary = `processed=${processed} alerted=${alerted} maxRowId=${maxRowId}`;
    logEvent(this.db, {
      type: 'imessage.poll',
      channel: ALERT_CHANNEL,
      summary,
      meta: { processed, alerted, maxRowId },
    });
    emitEvent({ ts: new Date().toISOString(), type: 'imessage.poll', channel: ALERT_CHANNEL, summary });
  }

  private fetchNewMessages(lastRowId: number): RawMessageRow[] {
    const stmt = this.chatDb!.prepare<[number], RawMessageRow>(`
      SELECT
        m.rowid,
        m.text,
        m.date,
        COALESCE(h.id, '')         AS handle_id,
        COALESCE(c.chat_identifier, '') AS chat_id,
        c.display_name
      FROM message m
      LEFT JOIN handle h         ON h.rowid = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
      LEFT JOIN chat c           ON c.rowid = cmj.chat_id
      WHERE m.rowid > ?
        AND m.is_from_me = 0
      ORDER BY m.rowid ASC
      LIMIT ${POLL_BATCH}
    `);
    return stmt.all(lastRowId);
  }

  private async processMessage(
    row: RawMessageRow,
    text: string,
  ): Promise<{ alerted: boolean }> {
    const sender = row.handle_id;
    const receivedIso = appleEpochToIso(row.date);
    const isGroup = !!(row.display_name?.trim());
    const subject = text.length > 50 ? `${text.slice(0, 50)}…` : text;

    const mail: MailSummary = {
      account: IMESSAGE_ACCOUNT,
      messageId: String(row.rowid),
      threadId: row.chat_id || sender,
      from: sender,
      fromEmail: sender,
      subject,
      receivedAtIso: receivedIso,
      snippet: text.slice(0, 200),
      bodyText: text,
    };

    const verdict = await classifyMail({ mail, config: this.config, db: this.db });

    if (verdict.kind === 'ignore') {
      log.info({ sender, reason: verdict.reason }, 'imessage ignored');
      logEvent(this.db, {
        type: 'imessage.ignored',
        channel: ALERT_CHANNEL,
        summary: subject,
        meta: { sender, rowid: row.rowid, reason: verdict.reason },
      });
      return { alerted: false };
    }

    const oneLineSummary = verdict.oneLineSummary || subject;
    const alertBody = this.buildAlertBody(verdict, mail, isGroup, row.display_name ?? null, receivedIso);
    const threadName = truncate(`💬 ${oneLineSummary}`, THREAD_NAME_MAX);
    const threadFirstMessage = text.length > 200 ? `\`\`\`\n${text}\n\`\`\`` : undefined;

    const channelId = this.config.imessageAlertChannelId;

    try {
      await this.poster.postMailAlert({
        channelId,
        threadName,
        initialMessage: alertBody,
        threadFirstMessage,
        senderEmail: sender,
        senderAccount: IMESSAGE_ACCOUNT,
      });
    } catch (err) {
      log.error({ err: (err as Error).message, rowid: row.rowid }, 'imessage: Discord 포스팅 실패');
      logEvent(this.db, {
        type: 'imessage.error',
        channel: ALERT_CHANNEL,
        summary: `discord post failed: ${subject}`,
        meta: { sender, rowid: row.rowid, error: (err as Error).message },
      });
      return { alerted: false };
    }

    const evtMeta = { sender, rowid: row.rowid, verdict: verdict.kind, isGroup };
    logEvent(this.db, {
      type: 'imessage.alert',
      channel: ALERT_CHANNEL,
      summary: oneLineSummary,
      meta: evtMeta,
    });
    emitEvent({
      ts: new Date().toISOString(),
      type: 'imessage.alert',
      channel: ALERT_CHANNEL,
      summary: oneLineSummary,
      metaJson: JSON.stringify(evtMeta),
    });

    return { alerted: true };
  }

  private buildAlertBody(
    verdict: Exclude<ImportanceVerdict, { kind: 'ignore' }>,
    mail: MailSummary,
    isGroup: boolean,
    groupName: string | null,
    receivedIso: string,
  ): string {
    const ownerUserId = this.config.env.DISCORD_OWNER_USER_ID;
    const ts = formatKst(receivedIso);
    const senderDisplay = isGroup
      ? `${groupName ?? '(그룹)'} (${mail.from})`
      : mail.from;
    const chatLabel = isGroup ? '💬 그룹채팅' : '💬 iMessage';

    if (verdict.kind === 'important') {
      return [
        `**[중요] ${verdict.oneLineSummary}** <@${ownerUserId}>`,
        `${chatLabel} | 👤 ${senderDisplay} | 📅 ${ts}`,
        '진행할까요? (예 / 아니오 / 이 발신자 무시)',
      ].join('\n');
    }
    return [
      `**[모호] ${verdict.oneLineSummary}** <@${ownerUserId}>`,
      `${chatLabel} | 👤 ${senderDisplay} | 📅 ${ts}`,
      '[a] 중요/긴급 [b] 정보성 [c] 이 발신자 무시',
    ].join('\n');
  }
}

function appleEpochToIso(appleNs: number): string {
  if (!appleNs || appleNs <= 0) return new Date().toISOString();
  const unixSec = Math.floor(appleNs / 1e9) + APPLE_EPOCH_OFFSET_SEC;
  return new Date(unixSec * 1000).toISOString();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatKst(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${fmt.format(new Date(iso)).replace(', ', ' ').replace(',', ' ')} KST`;
}
