import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from '../claude.js';
import { log } from '../log.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30분마다 체크
const DIGEST_HOUR_KST = 12; // 정오(KST)에 실행
const DISCORD_API = 'https://discord.com/api/v10';
const VMC_TOPICS_BASE = 'https://vibemafiaclub.com/topics';
const OPUS_MODEL = 'claude-opus-4-7';
const REWRITE_TIMEOUT_MS = 30_000;
const NAGER_DATE_API = 'https://date.nager.at/api/v3';

// 연도별 한국 공휴일 캐시 (YYYY-MM-DD 문자열 집합)
const koreanHolidayCache = new Map<number, Set<string>>();

async function fetchKoreanHolidays(year: number): Promise<Set<string>> {
  if (koreanHolidayCache.has(year)) return koreanHolidayCache.get(year)!;
  try {
    const res = await fetch(`${NAGER_DATE_API}/PublicHolidays/${year}/KR`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Array<{ date: string }>;
    const set = new Set(data.map((h) => h.date));
    koreanHolidayCache.set(year, set);
    return set;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'daily-digest: 공휴일 조회 실패, 공휴일 아닌 것으로 간주');
    return new Set();
  }
}

async function isKoreanHolidayOrWeekend(kstDate: Date): Promise<boolean> {
  const dow = kstDate.getUTCDay(); // UTC 기준이지만 KST Date 객체이므로 요일 일치
  if (dow === 0 || dow === 6) return true; // 일(0), 토(6)
  const year = Number(kstDate.toISOString().slice(0, 4));
  const dateStr = kstDate.toISOString().slice(0, 10);
  const holidays = await fetchKoreanHolidays(year);
  return holidays.has(dateStr);
}

interface DigestItem {
  title: string;
  slug: string;
  filePath: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function setFrontmatterField(content: string, key: string, value: string): string {
  const match = content.match(/^(---\n[\s\S]*?\n---)/);
  if (!match) return content;
  const fmBlock = match[1];
  const keyRegex = new RegExp(`^${key}:.*$`, 'm');
  let newFm: string;
  if (keyRegex.test(fmBlock)) {
    newFm = fmBlock.replace(keyRegex, `${key}: ${value}`);
  } else {
    // 마지막 --- 직전에 필드 삽입
    newFm = fmBlock.replace(/\n---$/, `\n${key}: ${value}\n---`);
  }
  return content.replace(fmBlock, newFm);
}

function markAsSent(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const updated = setFrontmatterField(content, 'digest_sent', 'true');
  fs.writeFileSync(filePath, updated, 'utf-8');
}

function extractUrlFromBody(content: string): string {
  const patterns = [
    /원본[_\s]?URL[:\s*]*(?:\*\*\s*)?(https?:\/\/\S+)/im,
    /\*\*URL\*\*:\s*(https?:\/\/\S+)/im,
    /원문[_\s]?링크:\s*(https?:\/\/\S+)/im,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m?.[1]) return m[1].replace(/[>)\]]+$/, '').trim();
  }
  return '';
}

function extractTitle(content: string, fm: Record<string, string>, slug: string): string {
  if (fm.title) return fm.title;
  // 한국어 title 필드
  if (fm['제목']) return fm['제목'];
  // 첫 번째 마크다운 heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].replace(/^\[RAW\]\s*/i, '').trim();
  return slug.replace(/-/g, ' ');
}

function scanUnsentItems(wikiDir: string): DigestItem[] {
  const rawDir = path.join(wikiDir, 'raw');
  if (!fs.existsSync(rawDir)) return [];

  const items: DigestItem[] = [];
  for (const filename of fs.readdirSync(rawDir)) {
    if (!filename.endsWith('.md')) continue;
    const filePath = path.join(rawDir, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content);
      if (fm.digest_sent === 'true') continue;
      const sourceUrl = fm.source_url ?? fm.hada_url ?? fm.url ?? extractUrlFromBody(content);
      if (!sourceUrl) continue;
      const slug = filename.replace(/\.md$/, '');
      const title = extractTitle(content, fm, slug);
      items.push({ title, slug, filePath });
    } catch {
      // 파일 읽기 실패 시 건너뜀
    }
  }
  return items;
}

function todayLabel(): string {
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const yy = nowKst.toISOString().slice(2, 4);
  const mm = nowKst.toISOString().slice(5, 7);
  const dd = nowKst.toISOString().slice(8, 10);
  return `${yy}.${mm}.${dd}`;
}

async function rewriteTitlesForDigest(
  items: DigestItem[],
  cwd: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (items.length === 0) return map;

  const input = JSON.stringify(items.map((it) => ({ slug: it.slug, title: it.title })));
  const prompt = `다음 JSON 배열의 각 title을 한국어 뉴스 기사 제목 스타일로 변환하라.
규칙:
- 핵심 내용 중심으로 간결하게
- "~출시", "~발표", "~공개", "~선보여" 등 동사형으로 마무리
- 원문 의미를 유지하고 과장 없이
- 영어 고유명사(브랜드명·제품명)는 그대로 유지

입력:
${input}

JSON 배열만 출력. 설명·마크다운 없이:
[{"slug": "...", "title": "..."}]`;

  try {
    const result = await runClaude({ cwd, prompt, model: OPUS_MODEL, timeoutMs: REWRITE_TIMEOUT_MS });
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return map;
    const parsed = JSON.parse(jsonMatch[0]) as Array<{ slug?: string; title?: string }>;
    for (const entry of parsed) {
      if (entry.slug && entry.title) map.set(entry.slug, entry.title);
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'daily-digest: title rewrite failed, using originals');
  }
  return map;
}

function buildDigestMessage(items: DigestItem[], titleOverrides: Map<string, string>): string {
  const lines: string[] = [
    `VMC Daily Digest (${todayLabel()})`,
    '',
    '> 하루 한번, VibeMafia가 큐레이팅한 AI 소식을 전송합니다.',
    '',
  ];
  items.forEach((item, i) => {
    const displayTitle = titleOverrides.get(item.slug) ?? item.title;
    lines.push(`${i + 1}. [${displayTitle}](${VMC_TOPICS_BASE}/${item.slug})`);
  });
  return lines.join('\n');
}

async function postToDiscord(token: string, channelId: string, content: string): Promise<void> {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord API error ${res.status}: ${text}`);
  }
}

export class DailyDigestScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastDigestDate: string | null = null;

  constructor(
    private readonly wikiDir: string,
    private readonly vmcBotToken: string,
    private readonly vmcChannelId: string,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.check();
    }, CHECK_INTERVAL_MS);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 스케줄러 시간 게이트 없이 즉시 실행 (엔드포인트 수동 트리거용) */
  async runDigest(): Promise<{ sent: number }> {
    log.info('daily-digest: running');

    const items = scanUnsentItems(this.wikiDir);
    if (items.length === 0) {
      log.info('daily-digest: no unsent items, skipping');
      return { sent: 0 };
    }

    // 전송 전에 먼저 마킹 — Discord 전송 후 재시작 시 중복 전송 방지
    for (const item of items) {
      try {
        markAsSent(item.filePath);
      } catch (err) {
        log.warn({ err: (err as Error).message, file: item.filePath }, 'daily-digest: markAsSent failed');
      }
    }

    const titleOverrides = await rewriteTitlesForDigest(items, this.wikiDir);
    const message = buildDigestMessage(items, titleOverrides);
    await postToDiscord(this.vmcBotToken, this.vmcChannelId, message);

    log.info({ count: items.length }, 'daily-digest: sent');
    return { sent: items.length };
  }

  private async check(): Promise<void> {
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const dateStr = nowKst.toISOString().slice(0, 10);
    const hour = nowKst.getUTCHours();

    if (this.lastDigestDate === dateStr) {
      log.debug('daily-digest: already ran today, skipping');
      return;
    }

    if (hour < DIGEST_HOUR_KST || hour >= DIGEST_HOUR_KST + 1) {
      log.debug({ hour }, 'daily-digest: not in digest window, skipping');
      return;
    }

    if (await isKoreanHolidayOrWeekend(nowKst)) {
      log.info({ date: dateStr }, 'daily-digest: 한국 공휴일/주말, 전송 건너뜀');
      this.lastDigestDate = dateStr;
      return;
    }

    this.lastDigestDate = dateStr;
    try {
      await this.runDigest();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'daily-digest: failed');
    }
  }
}
