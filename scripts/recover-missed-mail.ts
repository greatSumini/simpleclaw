/**
 * 2026-06-26 네트워크 장애 누락 메일 복구 (일회성).
 *
 * 06-26 14:19 UTC(23:19 KST) cursormatfia 계정에서 8건이 Discord(context-hub)에
 * 업로드되지 못하고 누락됨:
 *   - 1건: 분류 통과했으나 postMailAlert(Discord 전송) 실패  (RE: 유진그룹 …)
 *   - 7건: messages.get(fetch) 단계 실패 (내용 미상)
 * 당시 historyId-조기-전진 버그로 누락분이 재시도되지 않았다.
 *
 * 복구 방법: cursormatfia 의 mail_state.last_history_id 를 누락 직전 값(170730)으로
 * 되감는다. 서버 재시작 시 startup 폴링이 정상 파이프라인(필터→분류→알림→스레드 생성)으로
 * 재처리한다. 이미 알림된 메일은 mail_threads 멱등 체크로 스킵되므로 중복 게시 없음.
 *
 * 사용법:
 *   node --import tsx scripts/recover-missed-mail.ts           # dry-run (계획 + 누락분 조회)
 *   node --import tsx scripts/recover-missed-mail.ts --apply   # historyId 되감기
 * (실행 후 서버 재시작: launchctl kickstart -k gui/$(id -u)/com.claw)
 */
import 'dotenv/config';
import path from 'node:path';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { loadConfig } from '../dist/config.js';

const APPLY = process.argv.includes('--apply');
const ACCOUNT = 'cursormatfia@gmail.com';
const DB_PATH = path.resolve('data/simpleclaw.db');

// 누락 직전 마지막 정상 historyId (로그상 06-26 11:38 poll, 다음 사이클에서 드롭 발생).
const REWIND_TO = 170730;

const MISSED_IDS: Array<{ id: string; note: string }> = [
  { id: '19f02490e17f29cb', note: 'discord post failed (분류 통과)' },
  { id: '19f02edf07363e8b', note: 'fetch 실패' },
  { id: '19f030fc692bf859', note: 'fetch 실패' },
  { id: '19f0339409802c87', note: 'fetch 실패' },
  { id: '19f035511ebc7048', note: 'fetch 실패' },
  { id: '19f036e86c46c570', note: 'fetch 실패' },
  { id: '19f0390fad32aa8e', note: 'fetch 실패' },
  { id: '19f039426f352a81', note: 'fetch 실패' },
];

const NOISY = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM', 'TRASH', 'DRAFT'];

function hdr(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? '';
}

async function main() {
  const config = loadConfig();
  const acct = config.gmail.find((a) => a.email === ACCOUNT);
  if (!acct) throw new Error(`account not in config: ${ACCOUNT}`);

  const oauth = new google.auth.OAuth2({
    clientId: config.env.GMAIL_CLIENT_ID,
    clientSecret: config.env.GMAIL_CLIENT_SECRET,
  });
  oauth.setCredentials({ refresh_token: acct.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth });

  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  const state = db
    .prepare('SELECT last_history_id, last_polled_at FROM mail_state WHERE account = ?')
    .get(ACCOUNT) as { last_history_id: string; last_polled_at: string } | undefined;
  const isMapped = db.prepare('SELECT 1 FROM mail_threads WHERE gmail_msg_id = ?');

  console.log(`계정: ${ACCOUNT}`);
  console.log(`현재 mail_state.last_history_id = ${state?.last_history_id} (last_polled ${state?.last_polled_at})`);
  console.log(`되감기 목표 = ${REWIND_TO}\n`);
  console.log('누락 메일 현재 상태 (Gmail 재조회):');

  let recoverable = 0;
  for (const { id, note } of MISSED_IDS) {
    try {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });
      const m = res.data;
      const labels = m.labelIds ?? [];
      const subj = hdr(m.payload?.headers, 'Subject') || '(제목 없음)';
      const from = hdr(m.payload?.headers, 'From');
      const inInbox = labels.includes('INBOX');
      const noisy = labels.find((l) => NOISY.includes(l));
      const already = !!isMapped.get(id);
      const willPost = inInbox && !noisy && !already;
      if (willPost) recoverable++;
      const verdict = already
        ? '이미 게시됨(스킵)'
        : !inInbox
          ? 'INBOX 아님(스킵)'
          : noisy
            ? `노이즈 ${noisy}(스킵)`
            : '→ 재처리 대상';
      console.log(`  • ${id}  hid=${m.historyId}  [${verdict}]`);
      console.log(`      제목: ${subj.slice(0, 70)}`);
      console.log(`      발신: ${from.slice(0, 60)}  | ${note}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const gone = msg.includes('Requested entity was not found') || (e as { code?: number }).code === 404;
      console.log(`  • ${id}  [${gone ? '삭제됨(복구 불가)' : '조회 오류'}] ${gone ? '' : msg}`);
    }
  }

  console.log(`\n재처리 대상(분류 후 중요/모호면 게시): ${recoverable}건 / 전체 ${MISSED_IDS.length}건`);

  if (!APPLY) {
    console.log('\n(dry-run — 실제 되감기는 --apply, 이후 서버 재시작 필요)');
    db.close();
    return;
  }

  const cur = Number(state?.last_history_id);
  if (!Number.isFinite(cur) || cur <= REWIND_TO) {
    console.log(`\n⚠ 현재 historyId(${state?.last_history_id})가 되감기 목표 이하 — 중단(이미 되감겼거나 이상 상태).`);
    db.close();
    return;
  }
  db.prepare('UPDATE mail_state SET last_history_id = ? WHERE account = ?').run(String(REWIND_TO), ACCOUNT);
  console.log(`\n✅ mail_state.last_history_id ${state?.last_history_id} → ${REWIND_TO} 되감기 완료.`);
  console.log('이제 서버를 재시작하면 startup 폴링이 누락분을 재처리합니다:');
  console.log('   launchctl kickstart -k gui/$(id -u)/com.claw');
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
