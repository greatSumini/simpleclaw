import type Database from 'better-sqlite3';

export interface MailStateRow {
  account: string;
  lastHistoryId: string | null;
  lastPolledAt: string | null;
}

export type SenderPolicy = 'whitelist' | 'ignore';

export interface SenderPolicyRow {
  email: string;
  account: string;
  policy: SenderPolicy;
  reason: string | null;
  updatedAt: string;
}

export type MailThreadStatus = 'awaiting_user' | 'in_progress' | 'resolved';

export interface MailThreadRow {
  discordThreadId: string;
  discordMessageId: string | null;
  gmailMsgId: string;
  gmailThreadId: string;
  account: string;
  subject: string;
  status: MailThreadStatus;
  createdAt: string;
}

interface MailStateDbRow {
  account: string;
  last_history_id: string | null;
  last_polled_at: string | null;
}

interface SenderPolicyDbRow {
  email: string;
  account: string;
  policy: string;
  reason: string | null;
  updated_at: string;
}

interface MailThreadDbRow {
  discord_thread_id: string;
  discord_message_id: string | null;
  gmail_msg_id: string;
  gmail_thread_id: string;
  account: string;
  subject: string;
  status: string;
  created_at: string;
}

function fromMailStateRow(row: MailStateDbRow): MailStateRow {
  return {
    account: row.account,
    lastHistoryId: row.last_history_id,
    lastPolledAt: row.last_polled_at,
  };
}

function fromSenderPolicyRow(row: SenderPolicyDbRow): SenderPolicyRow {
  return {
    email: row.email,
    account: row.account,
    policy: row.policy as SenderPolicy,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

function fromMailThreadRow(row: MailThreadDbRow): MailThreadRow {
  return {
    discordThreadId: row.discord_thread_id,
    discordMessageId: row.discord_message_id ?? null,
    gmailMsgId: row.gmail_msg_id,
    gmailThreadId: row.gmail_thread_id,
    account: row.account,
    subject: row.subject,
    status: row.status as MailThreadStatus,
    createdAt: row.created_at,
  };
}

// ---------- mail_state ----------

export function getMailState(db: Database.Database, account: string): MailStateRow | null {
  if (!account) throw new Error('getMailState: account is required');
  const stmt = db.prepare<[string], MailStateDbRow>(
    'SELECT account, last_history_id, last_polled_at FROM mail_state WHERE account = ?',
  );
  const row = stmt.get(account);
  return row ? fromMailStateRow(row) : null;
}

export function setMailState(
  db: Database.Database,
  account: string,
  historyId: string,
): void {
  if (!account) throw new Error('setMailState: account is required');
  if (typeof historyId !== 'string') {
    throw new Error('setMailState: historyId must be a string');
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO mail_state (account, last_history_id, last_polled_at)
     VALUES (@account, @historyId, @now)
     ON CONFLICT(account) DO UPDATE SET
       last_history_id = excluded.last_history_id,
       last_polled_at  = excluded.last_polled_at`,
  );
  stmt.run({ account, historyId, now });
}

// ---------- sender_policies ----------

export function getSenderPolicy(
  db: Database.Database,
  email: string,
  account: string,
): SenderPolicyRow | null {
  if (!email) throw new Error('getSenderPolicy: email is required');
  if (!account) throw new Error('getSenderPolicy: account is required');
  const stmt = db.prepare<[string, string], SenderPolicyDbRow>(
    'SELECT email, account, policy, reason, updated_at FROM sender_policies WHERE email = ? AND account = ?',
  );
  const row = stmt.get(email, account);
  return row ? fromSenderPolicyRow(row) : null;
}

export interface SetSenderPolicyArgs {
  email: string;
  account: string;
  policy: SenderPolicy;
  reason?: string | null;
}

export function setSenderPolicy(db: Database.Database, args: SetSenderPolicyArgs): void {
  if (!args.email) throw new Error('setSenderPolicy: email is required');
  if (!args.account) throw new Error('setSenderPolicy: account is required');
  if (args.policy !== 'whitelist' && args.policy !== 'ignore') {
    throw new Error("setSenderPolicy: policy must be 'whitelist' or 'ignore'");
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO sender_policies (email, account, policy, reason, updated_at)
     VALUES (@email, @account, @policy, @reason, @now)
     ON CONFLICT(email, account) DO UPDATE SET
       policy     = excluded.policy,
       reason     = excluded.reason,
       updated_at = excluded.updated_at`,
  );
  stmt.run({
    email: args.email,
    account: args.account,
    policy: args.policy,
    reason: args.reason ?? null,
    now,
  });
}

export function deleteSenderPolicy(db: Database.Database, email: string): void {
  if (!email) throw new Error('deleteSenderPolicy: email is required');
  db.prepare('DELETE FROM sender_policies WHERE email = ?').run(email);
}

export function listSenderPolicies(
  db: Database.Database,
  account?: string,
): SenderPolicyRow[] {
  if (account !== undefined) {
    if (!account) throw new Error('listSenderPolicies: account, when provided, must be non-empty');
    const stmt = db.prepare<[string], SenderPolicyDbRow>(
      'SELECT email, account, policy, reason, updated_at FROM sender_policies WHERE account = ? ORDER BY updated_at DESC',
    );
    return stmt.all(account).map(fromSenderPolicyRow);
  }
  const stmt = db.prepare<[], SenderPolicyDbRow>(
    'SELECT email, account, policy, reason, updated_at FROM sender_policies ORDER BY updated_at DESC',
  );
  return stmt.all().map(fromSenderPolicyRow);
}

// ---------- mail_threads ----------

export interface CreateMailThreadArgs {
  discordThreadId: string;
  discordMessageId?: string | null;
  gmailMsgId: string;
  gmailThreadId: string;
  account: string;
  subject: string;
  status?: MailThreadStatus;
}

export function createMailThread(db: Database.Database, args: CreateMailThreadArgs): void {
  if (!args.discordThreadId) throw new Error('createMailThread: discordThreadId is required');
  if (!args.gmailMsgId) throw new Error('createMailThread: gmailMsgId is required');
  if (!args.gmailThreadId) throw new Error('createMailThread: gmailThreadId is required');
  if (!args.account) throw new Error('createMailThread: account is required');
  if (typeof args.subject !== 'string') {
    throw new Error('createMailThread: subject must be a string');
  }
  const status: MailThreadStatus = args.status ?? 'awaiting_user';
  if (status !== 'awaiting_user' && status !== 'in_progress' && status !== 'resolved') {
    throw new Error("createMailThread: status must be 'awaiting_user' | 'in_progress' | 'resolved'");
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO mail_threads
       (discord_thread_id, discord_message_id, gmail_msg_id, gmail_thread_id, account, subject, status, created_at)
     VALUES (@discordThreadId, @discordMessageId, @gmailMsgId, @gmailThreadId, @account, @subject, @status, @now)`,
  );
  stmt.run({
    discordThreadId: args.discordThreadId,
    discordMessageId: args.discordMessageId ?? null,
    gmailMsgId: args.gmailMsgId,
    gmailThreadId: args.gmailThreadId,
    account: args.account,
    subject: args.subject,
    status,
    now,
  });
}

const MAIL_THREAD_COLS = `discord_thread_id, discord_message_id, gmail_msg_id, gmail_thread_id, account, subject, status, created_at`;

export function getMailThread(
  db: Database.Database,
  discordThreadId: string,
): MailThreadRow | null {
  if (!discordThreadId) throw new Error('getMailThread: discordThreadId is required');
  const stmt = db.prepare<[string], MailThreadDbRow>(
    `SELECT ${MAIL_THREAD_COLS} FROM mail_threads WHERE discord_thread_id = ?`,
  );
  const row = stmt.get(discordThreadId);
  return row ? fromMailThreadRow(row) : null;
}

export function getMailThreadByMessageId(
  db: Database.Database,
  discordMessageId: string,
): MailThreadRow | null {
  if (!discordMessageId) throw new Error('getMailThreadByMessageId: discordMessageId is required');
  const stmt = db.prepare<[string], MailThreadDbRow>(
    `SELECT ${MAIL_THREAD_COLS} FROM mail_threads WHERE discord_message_id = ?`,
  );
  const row = stmt.get(discordMessageId);
  return row ? fromMailThreadRow(row) : null;
}

export function getMailThreadByGmailMsg(
  db: Database.Database,
  gmailMsgId: string,
): MailThreadRow | null {
  if (!gmailMsgId) throw new Error('getMailThreadByGmailMsg: gmailMsgId is required');
  const stmt = db.prepare<[string], MailThreadDbRow>(
    `SELECT ${MAIL_THREAD_COLS} FROM mail_threads WHERE gmail_msg_id = ?`,
  );
  const row = stmt.get(gmailMsgId);
  return row ? fromMailThreadRow(row) : null;
}

export function setMailThreadStatus(
  db: Database.Database,
  discordThreadId: string,
  status: MailThreadStatus,
): void {
  if (!discordThreadId) throw new Error('setMailThreadStatus: discordThreadId is required');
  if (status !== 'awaiting_user' && status !== 'in_progress' && status !== 'resolved') {
    throw new Error("setMailThreadStatus: status must be 'awaiting_user' | 'in_progress' | 'resolved'");
  }
  const stmt = db.prepare<[string, string]>(
    'UPDATE mail_threads SET status = ? WHERE discord_thread_id = ?',
  );
  stmt.run(status, discordThreadId);
}
