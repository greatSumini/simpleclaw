import type Database from 'better-sqlite3';
import { runClaude } from '../claude.js';
import { saveCandidate } from '../state/memories.js';
import { log } from '../log.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACTION_TIMEOUT_MS = 30_000;
const MIN_MESSAGE_LEN = 50;
const MIN_RESPONSE_LEN = 200;
const MAX_FACTS = 3;

interface ExtractedFact {
  key: string;
  type: string;
  value: string;
}

const PROMPT_TEMPLATE = `다음 대화에서 나중에 재사용 가능한 핵심 정보를 최대 ${MAX_FACTS}개 추출해라.

추출 기준:
- 유저의 반복될 수 있는 선호사항·패턴
- 레포/프로젝트에 대한 중요 사실
- 앞으로 유용할 기술적 컨텍스트

제외 기준:
- 단순 질문/응답 (1회성)
- 일반적 상식 (검색으로 알 수 있는 것)

대화:
{TRANSCRIPT}

JSON만 응답 (설명 없이):
[{"key":"짧은-식별자","type":"preference|fact|pattern","value":"설명 1-2문장"}]
없으면: []`;

export async function extractAndSaveFacts(
  db: Database.Database,
  simpleclawRepoPath: string,
  scope: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  // 내용이 충분하지 않으면 스킵
  if (userMessage.length < MIN_MESSAGE_LEN || assistantResponse.length < MIN_RESPONSE_LEN) return;

  const transcript =
    `사용자: ${userMessage.slice(0, 600)}\n\nSimpleClaw: ${assistantResponse.slice(0, 600)}`;
  const prompt = PROMPT_TEMPLATE.replace('{TRANSCRIPT}', transcript);

  let result;
  try {
    result = await runClaude({
      cwd: simpleclawRepoPath,
      prompt,
      model: HAIKU_MODEL,
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    });
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'fact-extractor: claude call failed');
    return;
  }

  let facts: ExtractedFact[];
  try {
    const jsonMatch = /\[[\s\S]*?\]/.exec(result.text);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (!Array.isArray(parsed)) return;
    facts = (parsed as unknown[]).filter((item): item is ExtractedFact => {
      if (!item || typeof item !== 'object') return false;
      const o = item as Record<string, unknown>;
      return typeof o.key === 'string' && o.key.length > 0 && typeof o.value === 'string' && o.value.length > 0;
    });
  } catch {
    log.debug({ text: result.text.slice(0, 200) }, 'fact-extractor: JSON parse failed');
    return;
  }

  let saved = 0;
  for (const fact of facts.slice(0, MAX_FACTS)) {
    try {
      saveCandidate(db, {
        scope,
        type: fact.type ?? 'fact',
        key: fact.key,
        value: fact.value,
        source: 'auto-extracted',
      });
      saved++;
    } catch {
      // ON CONFLICT은 무시
    }
  }

  if (saved > 0) {
    log.info({ saved, scope }, 'fact-extractor: candidates saved');
  }
}
