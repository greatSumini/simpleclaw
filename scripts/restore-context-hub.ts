/**
 * 2026-06-10 vmc-context-hub 채널 삭제 사고 복구 스크립트 (일회성).
 *
 * 최근 3일(6/8~6/10) 동안 삭제된 채널에 있던 메일 알림·작업 스레드를
 * 새 채널에 동일한 데이터로 재생성한다.
 *
 * 데이터 소스:
 *  - data/simpleclaw.db: mail_threads, sessions, events (스레드 이름·유저 메시지·타임스탬프)
 *  - Gmail API: 메일 알림 원문 재조회 (gmail_msg_id 기반)
 *  - ~/.claude/projects/.../<session>.jsonl: 대화 전문 (유저 발화 + 봇 응답)
 *
 * 사용법:
 *   pnpm tsx scripts/restore-context-hub.ts          # dry-run (계획 출력)
 *   pnpm tsx scripts/restore-context-hub.ts --apply  # 실제 복구 + DB 재매핑
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { google, type gmail_v1 } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APPLY = process.argv.includes('--apply');

const OLD_CHANNEL = '1501239899842547752';
const NEW_CHANNEL = '1514400891875233844';
const SINCE = '2026-06-08T00:00:00.000Z';
// 채널 삭제 시각 — 이후 생성된 스레드는 새 채널에 이미 존재하므로 제외
const UNTIL = '2026-06-10T10:39:59.000Z';
const OWNER_ID = process.env.DISCORD_OWNER_USER_ID ?? '';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? '';
const DB_PATH = path.resolve('data/simpleclaw.db');
const TRANSCRIPT_DIR = path.join(
  os.homedir(),
  '.claude/projects/-Users-sumin-repos-vibemafiaclub-context-hub',
);
const THREAD_NAME_MAX = 90;

// account email → GMAIL_REFRESH_TOKEN_N (simpleclaw.config.json gmail 배열 순서)
const TOKEN_INDEX: Record<string, number> = {
  'greatsumini@gmail.com': 1,
  'cursormatfia@gmail.com': 2,
  'lead@awesome.dev': 3,
  'sumin@vooster.ai': 4,
};
const ACCOUNT_LABEL: Record<string, string> = {
  'greatsumini@gmail.com': 'greatsumini',
  'cursormatfia@gmail.com': 'cursormatfia',
  'lead@awesome.dev': 'lead@awesome.dev',
  'sumin@vooster.ai': 'sumin@vooster',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function formatKst(iso: string): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  return `${fmt.format(d)} KST`;
}

function escapeDiscordMarkdown(s: string): string {
  return s.replace(/([\\*_~`|>])/g, '\\$1');
}

function makeThreadTitle(content: string): string {
  let s = (content ?? '').trim();
  s = s.replace(/^(?:<@[!&]?\d+>\s*)+/, '');
  s = s.replace(/^[\s\p{P}]+/u, '');
  s = s.replace(/\s+/g, ' ');
  const m = s.match(/^(.+?[.!?。！？])\s/);
  if (m && m[1].length <= THREAD_NAME_MAX) s = m[1];
  s = s.trim();
  if (s.length === 0) return 'untitled';
  if (s.length <= THREAD_NAME_MAX) return s;
  return s.slice(0, THREAD_NAME_MAX - 1).trimEnd() + '…';
}

function splitChunks(text: string, max = 1900): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Gmail body extraction (gmail.ts extractPlainText 축약 복제)
// ---------------------------------------------------------------------------

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function walk(part: gmail_v1.Schema$MessagePart, fn: (p: gmail_v1.Schema$MessagePart) => void) {
  fn(part);
  for (const p of part.parts ?? []) walk(p, fn);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined | null): string {
  if (!payload) return '';
  const byMime = (mime: string) => {
    const acc: string[] = [];
    walk(payload, (p) => {
      if (p.mimeType === mime && p.body?.data) acc.push(decodeBase64Url(p.body.data));
    });
    return acc.join('\n').trim();
  };
  const plain = byMime('text/plain');
  if (plain) return truncate(plain, 4000);
  const html = byMime('text/html');
  if (html) return truncate(htmlToText(html), 4000);
  return '';
}

// ---------------------------------------------------------------------------
// Transcript parsing — 유저 발화 + 턴별 최종 봇 응답 추출
// ---------------------------------------------------------------------------

interface Turn { user: string; reply: string | null }

function stripUserText(raw: string): string {
  let s = raw;
  // skill/컨텍스트 주입, 지시 wrapper 제거 (컨텍스트 프리픽스보다 먼저 — 둘 다 '---' 구분자 사용)
  s = s.replace(/\n\n---\n# 활성 Skill[\s\S]*$/, '');
  s = s.replace(/\n\n---\n# 저장된 컨텍스트[\s\S]*$/, '');
  s = s.replace(/\n\n---\n+지시:[\s\S]*$/, '');
  // 스레드 컨텍스트 프리픽스 (mail 스레드 첫 발화)
  if (s.startsWith('[스레드 이전 내용]')) {
    const idx = s.lastIndexOf('\n---\n');
    if (idx !== -1) s = s.slice(idx + 5);
  }
  // 첨부파일 임시경로 블록 → 마커로 대체 (경로는 이미 소멸)
  s = s.replace(/\n*\[첨부파일 저장됨[\s\S]*$/, '\n\n📎 (원본 메시지에 첨부파일 있음)');
  return s.trim();
}

function stripBotText(raw: string): string {
  return raw
    .replace(/__SIMPLECLAW_ARTIFACT__\s*\{[^\n]*\}/g, '')
    .replace(/__SIMPLECLAW_RESTART__/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseTranscript(sessionId: string): Turn[] {
  const file = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    if (d.type === 'user' && !d.isMeta) {
      const c = d.message?.content;
      if (typeof c === 'string' && !c.startsWith('<command-') && !c.startsWith('Caveat:')) {
        if (cur) turns.push(cur);
        cur = { user: stripUserText(c), reply: null };
      }
    } else if (d.type === 'assistant' && cur) {
      const blocks = d.message?.content ?? [];
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) cur.reply = stripBotText(b.text);
      }
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

// ---------------------------------------------------------------------------
// Discord REST
// ---------------------------------------------------------------------------

async function discordReq(method: string, url: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://discord.com/api/v10${url}`, {
      method,
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const j = await res.json();
      await sleep(((j.retry_after as number) ?? 1) * 1000 + 250);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  throw new Error(`rate-limited too many times: ${url}`);
}

async function postMessage(channelId: string, content: string): Promise<string> {
  let lastId = '';
  for (const chunk of splitChunks(content)) {
    const msg = await discordReq('POST', `/channels/${channelId}/messages`, { content: chunk });
    lastId = msg.id;
    await sleep(400);
  }
  return lastId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RestoreThread {
  oldId: string;
  createdAt: string;
  name: string;
  starter: string;        // 새 채널에 올릴 스레드 시작 메시지
  inThread: string[];     // 스레드 내부에 순서대로 올릴 메시지들
  isMail: boolean;
  hasSession: boolean;
}

async function main() {
  if (!BOT_TOKEN || !OWNER_ID) throw new Error('DISCORD_BOT_TOKEN / DISCORD_OWNER_USER_ID 필요');
  const db = new Database(DB_PATH);

  // --- 대상 스레드 수집 -----------------------------------------------------
  const mailRows = db.prepare(`
    SELECT m.* FROM mail_threads m
    WHERE m.created_at < ?
      AND (m.created_at >= ?
       OR EXISTS (SELECT 1 FROM events e WHERE e.thread_id = m.discord_thread_id AND e.ts >= ?))
  `).all(UNTIL, SINCE, SINCE) as any[];
  // context-hub 채널(=메일 알림 채널) 소속만: 메일 알림은 전부 이 채널이므로 모두 해당.
  // 단 3일 이전 생성 + 3일 내 활동 없음은 위 쿼리에서 이미 제외됨.

  const sessionRows = db.prepare(`
    SELECT * FROM sessions WHERE repo = 'vibemafiaclub/context-hub' AND created_at >= ? AND created_at < ?
  `).all(SINCE, UNTIL) as any[];

  const mailById = new Map(mailRows.map((m) => [m.discord_thread_id as string, m]));
  const sessionById = new Map(sessionRows.map((s) => [s.thread_id as string, s]));
  const allIds = [...new Set([...mailById.keys(), ...sessionById.keys()])];

  // 스레드 이름: events.channel 중 채널명/ID가 아닌 첫 값
  const nameStmt = db.prepare(`
    SELECT channel FROM events
    WHERE thread_id = ? AND channel IS NOT NULL
      AND channel NOT IN ('vmc-context-hub', ?) ORDER BY ts LIMIT 1
  `);
  // 유저 메시지 (스레드 내부 발화 — 타임스탬프 포함)
  const userMsgStmt = db.prepare(`
    SELECT ts, summary FROM events
    WHERE thread_id = ? AND type = 'discord.message.in' ORDER BY ts
  `);

  const threads: RestoreThread[] = [];

  for (const oldId of allIds) {
    const mail = mailById.get(oldId);
    const session = sessionById.get(oldId);
    const createdAt = (mail?.created_at ?? session?.created_at) as string;
    const turns: Turn[] = session ? parseTranscript(session.claude_session_id) : [];
    const userEvents = userMsgStmt.all(oldId) as { ts: string; summary: string }[];

    let name = (nameStmt.get(oldId, OLD_CHANNEL) as any)?.channel as string | undefined;
    let starter: string;
    const inThread: string[] = [];

    if (mail) {
      // 메일 원문 재조회 → 알림 메시지 + 상세 본문 재구성
      const alertEvt = db.prepare(`
        SELECT summary, meta_json FROM events
        WHERE type = 'mail.alert' AND thread_id = ? LIMIT 1
      `).get(oldId) as any;
      const meta = alertEvt ? JSON.parse(alertEvt.meta_json) : {};
      const oneLine = (alertEvt?.summary as string) ?? mail.subject;
      const verdictKind = (meta.verdict as string) ?? 'important';

      let fromDisplay = (meta.fromEmail as string) ?? '(unknown)';
      let bodyText = '(본문 복구 실패 — Gmail 재조회 불가)';
      let receivedIso = mail.created_at as string;
      try {
        const idx = TOKEN_INDEX[mail.account];
        const oauth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
        oauth.setCredentials({ refresh_token: process.env[`GMAIL_REFRESH_TOKEN_${idx}`] });
        const gmail = google.gmail({ version: 'v1', auth: oauth });
        const res = await gmail.users.messages.get({ userId: 'me', id: mail.gmail_msg_id, format: 'full' });
        const headers = res.data.payload?.headers ?? [];
        const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? '';
        fromDisplay = h('from') || fromDisplay;
        bodyText = extractPlainText(res.data.payload) || '(본문 없음)';
        if (res.data.internalDate) receivedIso = new Date(Number(res.data.internalDate)).toISOString();
      } catch (e) {
        console.warn(`  ⚠ gmail refetch 실패 (${oldId}): ${(e as Error).message}`);
      }

      const head = verdictKind === 'important' ? `**[중요] ${oneLine}**` : `**[모호] ${oneLine}**`;
      const tail = verdictKind === 'important'
        ? '진행할까요? (예 / 아니오 / 다른 방향 / 이 발신자 무시)'
        : '[a] 중요/긴급 [b] 정보성 [c] 이 발신자 무시';
      starter = [
        head,
        `📩 ${ACCOUNT_LABEL[mail.account] ?? mail.account} | 👤 ${escapeDiscordMarkdown(fromDisplay)} | 📅 ${formatKst(receivedIso)}`,
        tail,
      ].join('\n');
      name = name ?? truncate(`📩 ${oneLine}`, THREAD_NAME_MAX);
      inThread.push(`📝 **제목**: ${mail.subject}\n\n\`\`\`\n${bodyText}\n\`\`\``);
    } else {
      // 일반 작업 스레드: 첫 유저 발화가 시작 메시지
      const firstUser = turns[0]?.user || '(내용 복구 불가)';
      starter = `👤 **sumin** · ${formatKst(createdAt)}\n${firstUser}`;
      name = name ?? makeThreadTitle(firstUser);
    }

    // 대화 재생: 메일 스레드는 모든 턴이 스레드 내부 발화,
    // 일반 스레드는 turn[0].user가 starter이므로 reply부터.
    turns.forEach((t, i) => {
      const isStarterTurn = !mail && i === 0;
      if (!isStarterTurn && t.user) {
        // 유저 발화는 events 원문(전문, ≤500자였던 적 없음 확인됨)을 우선 사용 —
        // 트랜스크립트는 컨텍스트/skill wrapper 제거가 휴리스틱이라 events가 더 정확.
        const evt = userEvents[mail ? i : i - 1];
        const text = evt?.summary || t.user;
        inThread.push(`👤 **sumin**${evt ? ` · ${formatKst(evt.ts)}` : ''}\n${text}`);
      }
      if (t.reply) inThread.push(t.reply);
    });

    threads.push({
      oldId, createdAt, name: truncate(name!, THREAD_NAME_MAX), starter, inThread,
      isMail: !!mail, hasSession: !!session,
    });
  }

  threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // --- 출력 / 실행 -----------------------------------------------------------
  console.log(`복구 대상: ${threads.length}개 스레드 (메일 ${threads.filter(t => t.isMail).length}, 일반 ${threads.filter(t => !t.isMail).length})\n`);
  for (const t of threads) {
    console.log(`[${t.createdAt}] ${t.isMail ? '📩' : '🧵'} ${t.name}`);
    console.log(`    old=${t.oldId} 내부 메시지 ${t.inThread.length}개 session=${t.hasSession}`);
    if (process.env.DUMP === t.oldId) {
      console.log(`\n===== STARTER =====\n${t.starter}`);
      t.inThread.forEach((m, i) => console.log(`\n===== MSG ${i + 1} =====\n${m}`));
      console.log('');
    }
  }

  if (!APPLY) {
    console.log('\n(dry-run — 실제 복구하려면 --apply)');
    return;
  }

  console.log('\n--- 복구 시작 ---');
  await postMessage(NEW_CHANNEL, `♻️ **기록 복구** — 6/10 채널 삭제 사고로 사라진 6/8~6/10 스레드 ${threads.length}개를 아래에 재생성합니다. (원본 작성 시각은 각 메시지에 표기)`);

  const remapSession = db.prepare('UPDATE sessions SET thread_id = ? WHERE thread_id = ?');
  const remapAnalysis = db.prepare('UPDATE session_analyses SET source_thread_id = ? WHERE source_thread_id = ?');
  const remapMail = db.prepare('UPDATE mail_threads SET discord_thread_id = ?, discord_message_id = ? WHERE discord_thread_id = ?');

  for (const t of threads) {
    console.log(`복구 중: ${t.name}`);
    const starterId = await postMessage(NEW_CHANNEL, t.starter);
    const thread = await discordReq('POST', `/channels/${NEW_CHANNEL}/messages/${starterId}/threads`, {
      name: t.name,
      auto_archive_duration: 10080,
    });
    const newId = thread.id as string;
    for (const msg of t.inThread) {
      await postMessage(newId, msg);
    }
    // DB 재매핑 → 새 스레드에서 기존 claude 세션 이어가기 가능
    if (t.hasSession) {
      remapSession.run(newId, t.oldId);
      remapAnalysis.run(newId, t.oldId);
    }
    if (t.isMail) remapMail.run(newId, starterId, t.oldId);
    console.log(`  → ${t.oldId} → ${newId}`);
    await sleep(600);
  }

  console.log('--- 복구 완료 ---');
}

main().catch((e) => { console.error(e); process.exit(1); });
