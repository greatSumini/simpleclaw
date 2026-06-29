import type Database from 'better-sqlite3';
import type { AppConfig, RepoEntry } from '../config.js';
import { runClaude, ClaudeError } from '../claude.js';
import { log } from '../log.js';
import { logEvent } from '../state/events.js';
import { getSenderPolicy } from '../state/mail.js';
import type { ImportanceVerdict, MailSummary } from './types.js';

const CLASSIFIER_TIMEOUT_MS = 60_000;
const BODY_TRUNCATE = 1500;

/**
 * Domains/patterns that are always noise — auto-notification senders that
 * never require a human response. Checked before the LLM classifier to
 * save tokens and reduce false-positive "important" verdicts.
 *
 * Rules (in order of precedence):
 * 1. Exact email match
 * 2. Exact domain match
 * 3. Domain suffix match (e.g. ".google.com" matches any subdomain)
 * 4. Local-part prefix "no-reply" or "noreply" (catches service-wide patterns)
 *
 * Intentionally NOT included: cal.com (meeting confirmations are actionable),
 * github.com (PR/CI notifications contain useful info), bolta.io (invoicing).
 */
const SKIP_DOMAINS: string[] = [
  'accounts.google.com',
  'google.com',        // cloudplatform-noreply@google.com etc.
  'wallet-email.samsung.com',
  'wishket.com',
  'modusign.co.kr',
  'amazonaws.com',
  'vooster.ai',
  'gpters.org',
  'lemonsqueezy-mail.com',
  'skyboundrural.com',
];

/**
 * Returns true if the sender email should be skipped before LLM classification.
 * This catches well-known automated/notification senders that are never actionable.
 */
export function shouldSkipByDomainPattern(email: string): boolean {
  const lower = email.toLowerCase().trim();
  const atIdx = lower.indexOf('@');
  if (atIdx === -1) return false;

  const localPart = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  // Rule: no-reply / noreply local-part prefix (e.g. no-reply@modusign.co.kr)
  if (localPart === 'no-reply' || localPart === 'noreply' || localPart.startsWith('no-reply.') || localPart.startsWith('noreply.') || localPart.endsWith('.noreply') || localPart.endsWith('.no-reply')) {
    // Exceptions: senders where even no-reply emails are actionable
    const noReplyExceptions = ['github.com', 'cal.com', 'mavrks.com']; // mavrks.com = 래피드(latpeed): 상품심사·정산 등 actionable
    if (!noReplyExceptions.includes(domain)) return true;
  }

  // Rule: known noise domains / subdomains
  for (const skipDomain of SKIP_DOMAINS) {
    if (domain === skipDomain || domain.endsWith(`.${skipDomain}`)) return true;
  }

  return false;
}

interface ClassifierImportant {
  kind: 'important';
  oneLineSummary: string;
  suggestedActions: string[];
  contextNotes?: string;
}
interface ClassifierAmbiguous {
  kind: 'ambiguous';
  oneLineSummary: string;
  reason: string;
}
interface ClassifierIgnore {
  kind: 'ignore';
  reason: string;
}
type ClassifierOutput = ClassifierImportant | ClassifierAmbiguous | ClassifierIgnore;

function findRepoByChannelId(config: AppConfig, channelId: string): RepoEntry | undefined {
  return config.repoChannels.find((r) => r.channelId === channelId);
}

function buildClassifierPrompt(mail: MailSummary): string {
  const body = mail.bodyText
    ? mail.bodyText.length > BODY_TRUNCATE
      ? `${mail.bodyText.slice(0, BODY_TRUNCATE)}\n…(이하 생략)`
      : mail.bodyText
    : '(본문 없음)';

  const lines: string[] = [
    '당신은 메일 중요도 분류기. 아래 메일을 평가해 JSON 한 줄로 출력하라.',
    '',
    '기준:',
    '- 중요/긴급(important): 명확한 답변·결정·조치가 필요한 비즈니스/개인 메일. 고객사·파트너·결제·계약·법무·일정 변경·urgent 등',
    '- 모호(ambiguous): 중요해 보이지만 확신 어려움. 사람이 한 번 봐야 함',
    '- 무시(ignore): 마케팅·뉴스레터·자동알림·소셜 알림 등',
    '',
    `수신 계정: ${mail.account}`,
    `보낸이: ${mail.from}`,
    `제목: ${mail.subject}`,
    `요약(snippet): ${mail.snippet}`,
    '본문:',
    body,
    '',
    '출력 형식 — 정확히 한 줄, JSON만 (markdown fence 절대 금지):',
    '{"kind":"important","oneLineSummary":"<제목 요약 한 줄, 30자 이내>","suggestedActions":["<제안1>","<제안2>"],"contextNotes":"<있으면 기존 맥락 노트>"}',
    '또는',
    '{"kind":"ambiguous","oneLineSummary":"<제목 요약>","reason":"<왜 모호한지>"}',
    '또는',
    '{"kind":"ignore","reason":"<짧은 사유>"}',
    '',
    '---',
    'Reply with EXACTLY one JSON line, no markdown fences, no commentary.',
  ];
  return lines.join('\n');
}

function stripFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/, '');
    t = t.replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseClassifierOutput(raw: string): ClassifierOutput | null {
  const cleaned = stripFences(raw);
  const candidate = extractJsonObject(cleaned) ?? cleaned;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === 'important') {
    if (typeof obj.oneLineSummary !== 'string' || obj.oneLineSummary.length === 0) {
      return null;
    }
    const actions = Array.isArray(obj.suggestedActions)
      ? obj.suggestedActions.filter((x): x is string => typeof x === 'string')
      : [];
    const contextNotes =
      typeof obj.contextNotes === 'string' && obj.contextNotes.length > 0
        ? obj.contextNotes
        : undefined;
    return {
      kind: 'important',
      oneLineSummary: obj.oneLineSummary,
      suggestedActions: actions,
      contextNotes,
    };
  }
  if (kind === 'ambiguous') {
    if (typeof obj.oneLineSummary !== 'string' || obj.oneLineSummary.length === 0) {
      return null;
    }
    if (typeof obj.reason !== 'string') return null;
    return { kind: 'ambiguous', oneLineSummary: obj.oneLineSummary, reason: obj.reason };
  }
  if (kind === 'ignore') {
    if (typeof obj.reason !== 'string') return null;
    return { kind: 'ignore', reason: obj.reason };
  }
  return null;
}

/**
 * Classify a mail summary into an importance verdict.
 *
 * Short-circuits on sender_policies before calling claude:
 *   - whitelist → continues to claude (we still want suggestedActions)
 *     but contextNotes is augmented to mention whitelist.
 *   - ignore → returns immediately without claude.
 *
 * On claude/parse failure, returns 'ambiguous' so the user decides.
 */
export async function classifyMail(args: {
  mail: MailSummary;
  config: AppConfig;
  db: Database.Database;
}): Promise<ImportanceVerdict> {
  const { mail, config, db } = args;

  // 1. Domain pattern pre-filter — well-known automated senders, no LLM needed.
  if (shouldSkipByDomainPattern(mail.fromEmail)) {
    log.debug(
      { from: mail.fromEmail, account: mail.account, subject: mail.subject },
      'mail pre-filtered by domain pattern: ignore',
    );
    logEvent(db, {
      type: 'importance.classify',
      summary: `pattern ignore: ${mail.subject}`,
      meta: {
        mode: 'pattern',
        verdict: 'ignore',
        from: mail.fromEmail,
        account: mail.account,
        messageId: mail.messageId,
      },
    });
    return { kind: 'ignore', reason: 'sender domain pattern matched' };
  }

  // 2. Sender policy short-circuit.
  const policy = getSenderPolicy(db, mail.fromEmail, mail.account);
  if (policy?.policy === 'ignore') {
    log.info(
      { from: mail.fromEmail, account: mail.account, subject: mail.subject },
      'mail classified by sender policy: ignore',
    );
    logEvent(db, {
      type: 'importance.classify',
      summary: `policy ignore: ${mail.subject}`,
      meta: {
        mode: 'policy',
        verdict: 'ignore',
        from: mail.fromEmail,
        account: mail.account,
        messageId: mail.messageId,
      },
    });
    return { kind: 'ignore', reason: 'sender ignore-listed' };
  }

  // 3. Build classifier prompt and call claude.
  // Use the mail-alert repo's localPath as cwd so the classifier benefits from CLAUDE.md context.
  const alertRepo = findRepoByChannelId(config, config.mailAlertChannelId);
  const cwd = alertRepo?.localPath ?? config.paths.dataDir;
  const prompt = buildClassifierPrompt(mail);

  let raw: string;
  try {
    const result = await runClaude({
      cwd,
      prompt,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
    });
    raw = result.text;
  } catch (err) {
    const e = err instanceof ClaudeError ? err : (err as Error);
    log.error(
      { err: e.message, subject: mail.subject, account: mail.account },
      'mail classifier claude run failed',
    );
    logEvent(db, {
      type: 'importance.classify',
      summary: `classifier error: ${mail.subject}`,
      meta: {
        mode: 'error',
        verdict: 'ambiguous',
        error: e.message,
        from: mail.fromEmail,
        account: mail.account,
        messageId: mail.messageId,
      },
    });
    return {
      kind: 'ambiguous',
      oneLineSummary: mail.subject,
      reason: 'classifier error',
    };
  }

  const parsed = parseClassifierOutput(raw);
  if (!parsed) {
    log.error(
      { rawHead: raw.slice(0, 500), subject: mail.subject },
      'mail classifier produced unparseable output',
    );
    logEvent(db, {
      type: 'importance.classify',
      summary: `parse failure: ${mail.subject}`,
      meta: {
        mode: 'error',
        verdict: 'ambiguous',
        rawHead: raw.slice(0, 300),
        from: mail.fromEmail,
        account: mail.account,
        messageId: mail.messageId,
      },
    });
    return {
      kind: 'ambiguous',
      oneLineSummary: mail.subject,
      reason: 'classifier error',
    };
  }

  // 3. If whitelist and classifier said ignore — promote to ambiguous (whitelist trumps ignore).
  let verdict: ImportanceVerdict = parsed;
  if (policy?.policy === 'whitelist') {
    if (parsed.kind === 'ignore') {
      verdict = {
        kind: 'important',
        oneLineSummary: mail.subject,
        suggestedActions: [],
        contextNotes: '발신자 화이트리스트 (분류기는 무시 판정)',
      };
    } else if (parsed.kind === 'important') {
      verdict = {
        ...parsed,
        contextNotes:
          parsed.contextNotes && parsed.contextNotes.length > 0
            ? `${parsed.contextNotes} | 발신자 화이트리스트`
            : '발신자 화이트리스트',
      };
    }
    // ambiguous + whitelist: keep ambiguous (still important enough to surface).
  }

  logEvent(db, {
    type: 'importance.classify',
    summary: `${verdict.kind}: ${mail.subject}`,
    meta: {
      mode: 'llm',
      verdict: verdict.kind,
      from: mail.fromEmail,
      account: mail.account,
      messageId: mail.messageId,
      whitelist: policy?.policy === 'whitelist',
    },
  });

  return verdict;
}
