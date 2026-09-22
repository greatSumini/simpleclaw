import path from 'node:path';
import { type BackgroundJobRow, parseDbUtc } from '../state/background-jobs.js';
import { isSameProcessAlive, tailLog } from '../scheduler/job-process.js';

/**
 * Two deterministic guards around claw-job, both code-only (no LLM):
 *
 * 1. "다 했어?" in a thread with registered jobs is answered straight from the job table —
 *    44 such polls used to cost a full engine resume each (~76 min of turns in total).
 * 2. A reply that promises a follow-up ("완료되면 알려드릴게요") while no job is registered gets
 *    a visible warning, so an unbacked promise can't silently leave the user waiting.
 */

const STATUS_QUESTION =
  /^(다\s*(했|됐|끝났)(어|나|니|냐|어요|나요|습니까)?|끝났(어|나|니|냐|어요|나요)?|(지금\s*)?(진행\s*)?상황\s*(어때|어떄|은)?|어디까지\s*(했|됐)(어|나|니)?|아직\s*(이야|이에요|임|야)?)\s*[?？!.~ㅠㅜ]*$/;

export function isStatusQuestion(text: string): boolean {
  return STATUS_QUESTION.test(text.trim());
}

function elapsed(fromIso: string, now: number): string {
  const min = Math.max(0, Math.round((now - parseDbUtc(fromIso)) / 60_000));
  return min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

export function formatJobStatus(jobs: BackgroundJobRow[], now: number = Date.now()): string {
  const lines = [`아직입니다 — 이 스레드에서 진행 중인 백그라운드 작업 ${jobs.length}건 (SimpleClaw가 직접 확인한 상태):`];
  for (const job of jobs) {
    if (job.pid !== null) {
      const alive = isSameProcessAlive(job.pid, job.procStartedAt);
      lines.push(
        `• job #${job.id} ${job.description} — ${alive ? '실행 중' : '프로세스 종료, 결과 확인 대기(1분 내 알림)'} · 경과 ${elapsed(job.createdAt, now)}`,
      );
      const tail = job.jobDir ? tailLog(job.jobDir, 3) : '';
      if (tail) {
        const clipped = tail
          .split('\n')
          .map((l) => (l.length > 150 ? `${l.slice(0, 149)}…` : l))
          .join('\n')
          .replace(/```/g, "'''");
        lines.push(`\`\`\`\n${clipped}\n\`\`\``);
      }
      if (job.jobDir) lines.push(`  로그: ${path.join(job.jobDir, 'output.log')}`);
    } else {
      lines.push(
        `• job #${job.id} ${job.description} — 조건 대기 중 · 경과 ${elapsed(job.createdAt, now)}` +
          (job.lastError ? ` · 마지막 확인: ${job.lastError}` : ''),
      );
    }
  }
  lines.push('끝나면 이 스레드로 자동 알림이 옵니다. 등록된 작업 외의 진행 상황이 궁금하면 구체적으로 물어봐 주세요.');
  const out = lines.join('\n');
  return out.length > 1_900 ? `${out.slice(0, 1_899)}…` : out;
}

/** First-person commitment to report back / keep going. */
const COMMIT = /(알려\s*드리|알려드리|알려드릴|보고\s*드리겠|이어\s*가겠|이어가겠|이어서\s*(진행|처리)\s*하겠|대기하겠|지켜보겠|지켜보고\s*있)/;
/** …that hinges on something finishing after the turn ends. */
const ASYNC_TRIGGER = /(완료되|끝나|다\s*되|되는\s*대로|나오는\s*대로|나오면|백그라운드|진행\s*중|기다리|대기\s*중|모니터링|간격으로)/;
/**
 * …but not when the next step waits on the user (or an inbound reply SimpleClaw already
 * surfaces, like mail) — "로그인해주시면 이어서 처리하겠습니다" is a correct hand-off, and
 * warning on it would train the user to ignore the warning.
 */
const USER_CONDITION = /(주시면|주세요|말씀|회신|로그인|할까요|원하시면|하시면|알려주)/;

/** True if some sentence promises a follow-up that only an unattended process could deliver. */
export function detectsFollowUpPromise(text: string): boolean {
  // Quoted phrases are being talked about, not promised ("완료되면 알려드릴게요" 류 금지 등).
  const unquoted = text.replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, ' ');
  return unquoted
    .split(/(?<=[.!?。])\s+|\n+/)
    .some((sentence) => COMMIT.test(sentence) && ASYNC_TRIGGER.test(sentence) && !USER_CONDITION.test(sentence));
}

export const UNBACKED_PROMISE_WARNING =
  '\n\n⚠️ (SimpleClaw) 위 응답은 후속 알림/이어서 진행을 약속했지만 등록된 백그라운드 작업이 없습니다 — 자동 알림은 오지 않습니다. 필요하면 다시 요청해 주세요.';
