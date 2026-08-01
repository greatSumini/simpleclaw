/**
 * 특정 Gmail 메시지를 알림 파이프라인에 다시 태우기 (재분류 → Discord 알림).
 *
 * 용도: 분류기가 잘못 `ignore` 판정해서 알림이 안 뜬 메일을 되살릴 때.
 *
 * 동작:
 *   1. (--whitelist) 발신자를 sender_policies 에 whitelist 로 등록
 *      → 분류기가 다시 ignore 해도 important 로 승격됨 (importance.ts:330)
 *   2. 해당 계정의 mail_state.last_history_id 를 대상 메시지의 historyId 직전으로 되감음
 *      → 서버 재시작 시 정상 폴링 파이프라인이 재처리
 *   이미 알림된 메일은 mail_threads 멱등 체크(gmail.ts:480)로 스킵되므로 중복 게시 없음.
 *
 * 사용법:
 *   node --import tsx scripts/replay-mail.ts <account> <gmailMsgId> [--whitelist]           # dry-run
 *   node --import tsx scripts/replay-mail.ts <account> <gmailMsgId> [--whitelist] --apply
 * (실행 후 서버 재시작: launchctl kickstart -k gui/$(id -u)/com.claw)
 */
import 'dotenv/config';
import path from 'node:path';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { loadConfig } from '../dist/config.js';
import { setSenderPolicy, setMailState } from '../dist/state/mail.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const WHITELIST = args.includes('--whitelist');
const [ACCOUNT, MSG_ID] = args.filter((a) => !a.startsWith('--'));

if (!ACCOUNT || !MSG_ID) {
  console.error('usage: replay-mail.ts <account> <gmailMsgId> [--whitelist] [--apply]');
  process.exit(1);
}

const DB_PATH = path.resolve('data/simpleclaw.db');

function hdr(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? '';
}

function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

async function main() {
  const config = loadConfig();
  const acct = config.gmail.find((a: { email: string }) => a.email === ACCOUNT);
  if (!acct) throw new Error(`account not in config: ${ACCOUNT}`);

  const oauth = new google.auth.OAuth2({
    clientId: config.env.GMAIL_CLIENT_ID,
    clientSecret: config.env.GMAIL_CLIENT_SECRET,
  });
  oauth.setCredentials({ refresh_token: acct.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth });

  const res = await gmail.users.messages.get({ userId: 'me', id: MSG_ID, format: 'metadata' });
  const msg = res.data;
  const from = hdr(msg.payload?.headers ?? undefined, 'From');
  const subject = hdr(msg.payload?.headers ?? undefined, 'Subject');
  const fromEmail = extractEmail(from);
  const historyId = msg.historyId;
  if (!historyId) throw new Error('message has no historyId');

  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  const state = db
    .prepare('SELECT last_history_id, last_polled_at FROM mail_state WHERE account = ?')
    .get(ACCOUNT) as { last_history_id: string; last_polled_at: string } | undefined;
  const mapped = db.prepare('SELECT 1 FROM mail_threads WHERE gmail_msg_id = ?').get(MSG_ID);

  const rewindTo = String(BigInt(historyId) - 1n);

  console.log(`계정        : ${ACCOUNT}`);
  console.log(`메시지      : ${MSG_ID}`);
  console.log(`제목        : ${subject}`);
  console.log(`발신자      : ${from}`);
  console.log(`라벨        : ${(msg.labelIds ?? []).join(', ')}`);
  console.log(`msg history : ${historyId}`);
  console.log(`현재 커서   : ${state?.last_history_id} (last_polled ${state?.last_polled_at})`);
  console.log(`되감기 목표 : ${rewindTo}`);
  console.log(`이미 알림됨 : ${mapped ? 'YES (재처리해도 스킵됨)' : 'no'}`);
  console.log(`whitelist   : ${WHITELIST ? `${fromEmail} → whitelist 등록` : '(안 함)'}`);

  if (!APPLY) {
    console.log('\n[dry-run] --apply 를 붙이면 실제로 적용합니다.');
    db.close();
    return;
  }

  if (WHITELIST) {
    setSenderPolicy(db, {
      email: fromEmail,
      account: ACCOUNT,
      policy: 'whitelist',
      reason: 'replay-mail.ts: 분류기 오판(ignore) 교정',
    });
    console.log(`\n✅ sender_policies: ${fromEmail} → whitelist`);
  }

  setMailState(db, ACCOUNT, rewindTo);
  console.log(`✅ mail_state.last_history_id: ${state?.last_history_id} → ${rewindTo}`);
  console.log('\n서버 재시작 필요: launchctl kickstart -k gui/$(id -u)/com.claw');
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
