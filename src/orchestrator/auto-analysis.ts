import type Database from 'better-sqlite3';
import { listEventsByThread } from '../state/events.js';
import type { ThreadMemoryRef } from '../state/memories.js';

// ---------------------------------------------------------------------------
// Skill proposal parsing
// ---------------------------------------------------------------------------

export interface SkillProposalData {
  kind: 'simpleclaw' | 'repo';
  name: string;
  description: string;
  content: string;
  repoFullName?: string;
}

const PROPOSALS_BLOCK_REGEX = /<!--\s*SKILL_PROPOSALS:\s*([\s\S]*?)-->/;

export function parseSkillProposals(text: string): SkillProposalData[] {
  const match = PROPOSALS_BLOCK_REGEX.exec(text);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[1].trim()) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((item): item is SkillProposalData => {
      if (!item || typeof item !== 'object') return false;
      const o = item as Record<string, unknown>;
      return (
        (o.kind === 'simpleclaw' || o.kind === 'repo') &&
        typeof o.name === 'string' && o.name.length > 0 &&
        typeof o.description === 'string' && o.description.length > 0 &&
        typeof o.content === 'string' && o.content.length > 0
      );
    });
  } catch {
    return [];
  }
}

export function stripSkillProposalsBlock(text: string): string {
  return text.replace(PROPOSALS_BLOCK_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Memory score parsing
// ---------------------------------------------------------------------------

export interface MemoryScoreDelta {
  id: number;
  layer: 'candidate' | 'memory';
  delta: number;
}

const MEMORY_SCORES_BLOCK_REGEX = /<!--\s*MEMORY_SCORES:\s*([\s\S]*?)-->/;

export function parseMemoryScores(text: string): MemoryScoreDelta[] {
  const match = MEMORY_SCORES_BLOCK_REGEX.exec(text);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[1].trim()) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((item): item is MemoryScoreDelta => {
      if (!item || typeof item !== 'object') return false;
      const o = item as Record<string, unknown>;
      return (
        typeof o.id === 'number' &&
        (o.layer === 'candidate' || o.layer === 'memory') &&
        typeof o.delta === 'number'
      );
    });
  } catch {
    return [];
  }
}

export function stripMemoryScoresBlock(text: string): string {
  return text.replace(MEMORY_SCORES_BLOCK_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Conversation transcript builder
// ---------------------------------------------------------------------------

/**
 * Build a human-readable transcript from a thread's event history.
 * Only includes inbound user messages and outbound claw responses.
 * Each entry is truncated to 300 chars (events table stores up to 200 anyway).
 */
export function buildConversationTranscript(
  db: Database.Database,
  threadId: string,
): string {
  const events = listEventsByThread(db, threadId, 100);
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'discord.message.in' && ev.type !== 'discord.message.out') continue;
    const who = ev.type === 'discord.message.in' ? '사용자' : 'SimpleClaw';
    const ts = ev.ts.slice(0, 19).replace('T', ' ');
    const text = ev.summary.length > 300 ? ev.summary.slice(0, 300) + '…' : ev.summary;
    lines.push(`[${ts}] ${who}: ${text}`);
  }
  return lines.join('\n') || '(대화 기록 없음)';
}

// ---------------------------------------------------------------------------
// Analysis prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the prompt sent to Claude for auto-analysis.
 * Claude runs in the claw repo CWD so it can inspect the codebase.
 * `repo` is the GitHub fullName of the repo that was worked on (e.g. "vibemafiaclub/context-hub").
 */
export function buildAnalysisPrompt(
  threadId: string,
  transcript: string,
  repo: string,
  injectedMemories?: ThreadMemoryRef[],
): string {
  const hasMemories = injectedMemories && injectedMemories.length > 0;

  const memorySection = hasMemories
    ? [
        '',
        '## 이 대화에서 주입된 메모리',
        injectedMemories
          .map((m) => `- id:${m.id} layer:${m.layer} [${m.type}] ${m.key}: ${m.value}`)
          .join('\n'),
      ].join('\n')
    : '';

  const memoryScoresInstruction = hasMemories
    ? [
        '',
        '5. **메모리 평가**: 위 주입된 메모리 중 대화 내용으로 유효성을 판단할 수 있는 것만 평가해줘.',
        '   - 실제로 도움이 됐거나 응답에서 참조된 경우: delta +10',
        '   - 내용이 틀렸거나 혼란을 유발한 경우: delta -20',
        '   - 판단 불가이거나 중립이면 목록에서 생략',
      ].join('\n')
    : '';

  const memoryScoresBlock = hasMemories
    ? [
        '',
        'MEMORY_SCORES 블록을 **SKILL_PROPOSALS 블록 바로 앞**에 추가하라 (JSON 한 줄, 평가 가능한 것만):',
        '<!-- MEMORY_SCORES: [{"id":1,"layer":"memory","delta":10},{"id":2,"layer":"candidate","delta":-20}] -->',
        '평가할 게 없으면: <!-- MEMORY_SCORES: [] -->',
      ].join('\n')
    : '';

  return [
    `다음은 SimpleClaw Discord 에이전트가 처리한 작업 대화입니다 (thread: ${threadId}, repo: ${repo}).`,
    '',
    '## 대화 기록',
    transcript,
    memorySection,
    '',
    '---',
    '',
    `이 대화(repo: ${repo})를 분석해서 시스템 개선 포인트를 찾아줘:`,
    '',
    '1. **반복 패턴**: 사용자가 같은 종류의 지시를 여러 번 했거나, Claude가 알아서 처리했어야 할 것을 물어본 경우',
    `2. **개선 제안** (3개 이하): ${repo} 또는 SimpleClaw 코드/프롬프트에서 구체적으로 개선할 수 있는 항목과 구현 방법`,
    '3. **우선순위**: 임팩트 순',
    '4. **Skill 추가 제안**: 이 대화에서 skill로 자동화하면 좋을 패턴이 있는지 판단해줘.',
    '   - **SimpleClaw skill 후보** (`simpleclaw/skills/`에 추가): 레포와 무관하게 반복되는 인터랙션 패턴 (B2B 이메일, 캘린더, SimpleClaw 시스템 지식 등). 후보가 있으면 name·description·주입할 지침 요약 제안.',
    `   - **Repo skill 후보** (\`${repo}/.claude/skills/\`에 추가): 이 repo 코드베이스에 종속된 구현 패턴 (API 추가 방법, 특정 CLI 사용법 등). 후보가 있으면 name·description·주입할 지침 요약 제안.`,
    '   - 해당 없으면 각각 "없음".',
    memoryScoresInstruction,
    '',
    '분석 결과(반복 패턴, 각 개선 제안의 내용·구현 방법·우선순위, skill 제안)를 항목별로 **상세히** 제시해라. 내용 생략 금지.',
    '',
    '---',
    '',
    memoryScoresBlock,
    '',
    '분析 텍스트 출력 후 **마지막 줄**에 반드시 아래 블록을 추가하라 (JSON 한 줄, skill 후보 없으면 빈 배열):',
    `<!-- SKILL_PROPOSALS: [{"kind":"simpleclaw","name":"영문-이름","description":"한 줄 설명","content":"---\\nname: 이름\\ndescription: 설명\\ntriggers:\\n  - 키워드\\n---\\n\\n# 내용"},{"kind":"repo","name":"영문-이름","description":"한 줄 설명","content":"---\\nname: 이름\\n---\\n\\n# 내용","repoFullName":"${repo}"}] -->`,
    'name은 영문 소문자+하이픈만. content의 개행은 \\n. 후보 없으면: <!-- SKILL_PROPOSALS: [] -->',
  ].join('\n');
}
