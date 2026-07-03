import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runClaude } from '../claude.js';
import { log } from '../log.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const DETECTOR_TIMEOUT_MS = 20_000;
const LAST_RESPONSE_MAX_LEN = 800;

/** 단문 확인어: 15자 이하, 개행 없음, 기존 세션 있을 때 이전 skill 상속 */
const SHORT_CONFIRM_MAX_LEN = 15;

interface SkillEntry {
  name: string;
  description: string;
  content: string;
  scope: 'internal' | 'shared';
}

/** @internal exported for testing */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (key && val) meta[key] = val;
    }
  }
  return { meta, body: match[2].trim() };
}

/** @internal exported for testing */
export async function loadSkills(skillsDir: string): Promise<SkillEntry[]> {
  if (!existsSync(skillsDir)) return [];

  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
    try {
      const raw = await readFile(skillMdPath, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      if (meta['name'] && meta['description']) {
        const scope = meta['scope'] === 'internal' ? 'internal' : 'shared';
        skills.push({ name: meta['name'], description: meta['description'], content: body, scope });
      }
    } catch {
      // skip missing or malformed SKILL.md
    }
  }
  return skills;
}

function buildDetectorPrompt(
  skills: SkillEntry[],
  userMessage: string,
  previousResponse?: string,
): string {
  const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  let context = `유저 메시지:\n${userMessage}`;
  if (previousResponse) {
    context += `\n\n직전 에이전트 응답 (요약):\n${previousResponse}`;
  }
  return `다음 skills 중 이 대화에 가장 적합한 것을 하나 선택하라. 해당 없으면 null.

사용 가능한 skills:
${skillList}

${context}

반드시 JSON만 출력. 설명·마크다운 없이:
{"skill": "<skill-name>" | null}`;
}

export interface DetectSkillArgs {
  userMessage: string;
  previousResponse?: string | null;
  cachedSkill?: string | null;
  skillsDir: string;
  /** internal-scope skill 후보 포함 여부. SimpleClaw 자체 유지보수 세션에서만 true. */
  allowInternal?: boolean;
}

export interface DetectSkillResult {
  skill: string | null;
  content: string | null;
}

export async function detectSkill(args: DetectSkillArgs): Promise<DetectSkillResult> {
  const loaded = await loadSkills(args.skillsDir);
  const skills = args.allowInternal ? loaded : loaded.filter((s) => s.scope !== 'internal');
  if (skills.length === 0) return { skill: null, content: null };

  // 단문 확인어 + 기존 캐시 → 상속 (internal skill은 non-internal 컨텍스트에 상속되지 않음)
  if (
    args.cachedSkill != null &&
    args.userMessage.length <= SHORT_CONFIRM_MAX_LEN &&
    !args.userMessage.includes('\n')
  ) {
    const found = skills.find((s) => s.name === args.cachedSkill);
    if (found) {
      log.debug({ cachedSkill: args.cachedSkill }, 'skill-detector: inherited cached skill');
      return { skill: args.cachedSkill, content: found.content };
    }
  }

  const prompt = buildDetectorPrompt(
    skills,
    args.userMessage,
    args.previousResponse ?? undefined,
  );

  try {
    const result = await runClaude({
      cwd: path.dirname(args.skillsDir),
      prompt,
      model: HAIKU_MODEL,
      timeoutMs: DETECTOR_TIMEOUT_MS,
    });

    const jsonMatch = result.text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return { skill: null, content: null };

    const parsed = JSON.parse(jsonMatch[0]) as { skill?: string | null };
    const skillName = parsed.skill ?? null;
    if (!skillName) return { skill: null, content: null };

    const found = skills.find((s) => s.name === skillName);
    if (!found) {
      log.warn({ skillName }, 'skill-detector: unknown skill returned by haiku');
      return { skill: null, content: null };
    }

    log.info({ skill: skillName }, 'skill-detector: detected');
    return { skill: skillName, content: found.content };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'skill-detector: failed, continuing without skill');
    return { skill: null, content: null };
  }
}

/** 응답 텍스트를 lastResponse 캐시용으로 잘라냄 */
export function truncateForCache(text: string): string {
  return text.slice(0, LAST_RESPONSE_MAX_LEN);
}
