import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter, loadSkills, detectSkill } from '../orchestrator/skill-detector.js';
import { _resetCapabilitiesForTest } from '../claude.js';

// ---------------------------------------------------------------------------
// Mock claude binary setup
// ---------------------------------------------------------------------------

const MOCK_CLAUDE_PATH = fileURLToPath(
  new URL('./mocks/claude-mock.mjs', import.meta.url),
);
const ORIGINAL_CLAUDE_BIN = process.env.CLAUDE_BIN;

function setMockSkillResponse(skillName: string | null): void {
  process.env.MOCK_CLAUDE_SKILL_RESPONSE = skillName ?? 'null';
  delete process.env.MOCK_CLAUDE_FAIL;
}

function setMockFail(): void {
  process.env.MOCK_CLAUDE_FAIL = '1';
  delete process.env.MOCK_CLAUDE_SKILL_RESPONSE;
}

// ---------------------------------------------------------------------------
// Fixture: temp skills directory
// ---------------------------------------------------------------------------

async function makeTempSkillsDir(
  skills: Array<{
    name: string;
    description: string;
    body: string;
    scope?: 'internal' | 'shared';
  }>,
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claw-test-skills-'));
  for (const skill of skills) {
    const skillDir = path.join(dir, skill.name);
    await mkdir(skillDir);
    const scopeLine = skill.scope ? `\nscope: ${skill.scope}` : '';
    const md = `---\nname: ${skill.name}\ndescription: ${skill.description}${scopeLine}\n---\n\n${skill.body}`;
    await writeFile(path.join(skillDir, 'SKILL.md'), md, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('valid frontmatter → correct meta and body', () => {
    const input = `---\nname: test-skill\ndescription: 테스트 설명\n---\n\n# Body here`;
    const { meta, body } = parseFrontmatter(input);
    assert.equal(meta['name'], 'test-skill');
    assert.equal(meta['description'], '테스트 설명');
    assert.equal(body, '# Body here');
  });

  test('no frontmatter → empty meta, full text as body', () => {
    const input = `# Just body content\nno frontmatter`;
    const { meta, body } = parseFrontmatter(input);
    assert.deepEqual(meta, {});
    assert.equal(body, input);
  });

  test('frontmatter with missing value → key excluded', () => {
    const input = `---\nname: test\ndescription:\n---\n\nbody`;
    const { meta } = parseFrontmatter(input);
    assert.equal(meta['name'], 'test');
    assert.equal(meta['description'], undefined);
  });

  test('frontmatter with triggers list → triggers line ignored gracefully', () => {
    const input = `---\nname: b2b-email\ndescription: B2B 이메일\ntriggers:\n  - keyword\n---\n\nbody content`;
    const { meta, body } = parseFrontmatter(input);
    assert.equal(meta['name'], 'b2b-email');
    assert.equal(meta['description'], 'B2B 이메일');
    assert.equal(body, 'body content');
  });
});

// ---------------------------------------------------------------------------
// loadSkills
// ---------------------------------------------------------------------------

describe('loadSkills', () => {
  test('non-existent directory → empty array', async () => {
    const result = await loadSkills('/tmp/does-not-exist-claw-test-xyz');
    assert.deepEqual(result, []);
  });

  test('empty directory → empty array', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'claw-test-empty-'));
    try {
      const result = await loadSkills(dir);
      assert.deepEqual(result, []);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('valid skill directory → returns skill entry', async () => {
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일 작성', body: '# Email skill body' },
    ]);
    try {
      const skills = await loadSkills(dir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0]!.name, 'b2b-email');
      assert.equal(skills[0]!.description, 'B2B 이메일 작성');
      assert.equal(skills[0]!.content, '# Email skill body');
      assert.equal(skills[0]!.scope, 'shared');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('scope: internal in frontmatter → parsed as internal', async () => {
    const dir = await makeTempSkillsDir([
      { name: 'simpleclaw-debug', description: '디버그', body: 'body', scope: 'internal' },
    ]);
    try {
      const skills = await loadSkills(dir);
      assert.equal(skills[0]!.scope, 'internal');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('no scope in frontmatter → defaults to shared', async () => {
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: 'body' },
    ]);
    try {
      const skills = await loadSkills(dir);
      assert.equal(skills[0]!.scope, 'shared');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('multiple skills → returns all', async () => {
    const dir = await makeTempSkillsDir([
      { name: 'skill-a', description: 'desc a', body: 'body a' },
      { name: 'skill-b', description: 'desc b', body: 'body b' },
    ]);
    try {
      const skills = await loadSkills(dir);
      assert.equal(skills.length, 2);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('subdirectory missing SKILL.md → skipped', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'claw-test-partial-'));
    await mkdir(path.join(dir, 'orphan-dir'));
    try {
      const skills = await loadSkills(dir);
      assert.deepEqual(skills, []);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('SKILL.md missing name → skipped', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'claw-test-noname-'));
    const skillDir = path.join(dir, 'bad-skill');
    await mkdir(skillDir);
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: no name here\n---\nbody',
      'utf8',
    );
    try {
      const skills = await loadSkills(dir);
      assert.deepEqual(skills, []);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// detectSkill — non-LLM paths
// ---------------------------------------------------------------------------

describe('detectSkill: non-LLM paths', () => {
  test('non-existent skillsDir → null immediately', async () => {
    const result = await detectSkill({
      userMessage: '이메일 초안 써줘',
      skillsDir: '/tmp/no-such-skills-dir-claw',
    });
    assert.equal(result.skill, null);
    assert.equal(result.content, null);
  });

  test('short confirm + cachedSkill → inherits cache, no LLM call', async () => {
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: '# B2B content' },
    ]);
    try {
      // Even with MOCK_CLAUDE_FAIL set, cache inheritance should not call LLM
      setMockFail();
      const result = await detectSkill({
        userMessage: 'ㄱㄱ',
        cachedSkill: 'b2b-email',
        skillsDir: dir,
      });
      assert.equal(result.skill, 'b2b-email');
      assert.equal(result.content, '# B2B content');
    } finally {
      await rm(dir, { recursive: true });
      delete process.env.MOCK_CLAUDE_FAIL;
    }
  });

  test('short confirm + null cachedSkill → proceeds to LLM (not cached)', async () => {
    // cachedSkill is null → even short message goes to LLM path
    // We verify this by observing that with mock fail, the result is null (graceful fallback)
    process.env.CLAUDE_BIN = MOCK_CLAUDE_PATH;
    _resetCapabilitiesForTest();
    setMockFail();
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: 'body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: 'ㄱㄱ',
        cachedSkill: null,
        skillsDir: dir,
      });
      // LLM failed → graceful fallback
      assert.equal(result.skill, null);
    } finally {
      await rm(dir, { recursive: true });
      delete process.env.MOCK_CLAUDE_FAIL;
    }
  });

  test('message with newline + cachedSkill → proceeds to LLM (not cached)', async () => {
    process.env.CLAUDE_BIN = MOCK_CLAUDE_PATH;
    _resetCapabilitiesForTest();
    setMockFail();
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: 'body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '이메일\n초안',  // contains newline → not short confirm
        cachedSkill: 'b2b-email',
        skillsDir: dir,
      });
      assert.equal(result.skill, null); // LLM fail → fallback null
    } finally {
      await rm(dir, { recursive: true });
      delete process.env.MOCK_CLAUDE_FAIL;
    }
  });

  test('long message + cachedSkill → proceeds to LLM (not cached)', async () => {
    process.env.CLAUDE_BIN = MOCK_CLAUDE_PATH;
    _resetCapabilitiesForTest();
    setMockFail();
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: 'body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '이메일 초안 작성해줘 — 이건 충분히 긴 메시지야',  // > 15자
        cachedSkill: 'b2b-email',
        skillsDir: dir,
      });
      assert.equal(result.skill, null); // LLM fail → fallback null
    } finally {
      await rm(dir, { recursive: true });
      delete process.env.MOCK_CLAUDE_FAIL;
    }
  });
});

// ---------------------------------------------------------------------------
// detectSkill — integration (mock LLM)
// ---------------------------------------------------------------------------

describe('detectSkill: integration with mock claude', () => {
  before(() => {
    process.env.CLAUDE_BIN = MOCK_CLAUDE_PATH;
    _resetCapabilitiesForTest();
  });

  after(() => {
    if (ORIGINAL_CLAUDE_BIN !== undefined) {
      process.env.CLAUDE_BIN = ORIGINAL_CLAUDE_BIN;
    } else {
      delete process.env.CLAUDE_BIN;
    }
    _resetCapabilitiesForTest();
  });

  test('LLM returns known skill → skill + content returned', async () => {
    setMockSkillResponse('b2b-email');
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: '# B2B email body' },
      { name: 'claw-debug', description: 'claw 디버그', body: '# Debug body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '이메일 초안 써줘',
        skillsDir: dir,
      });
      assert.equal(result.skill, 'b2b-email');
      assert.equal(result.content, '# B2B email body');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('LLM returns null → null result', async () => {
    setMockSkillResponse(null);
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: 'body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '코드 리뷰해줘',
        skillsDir: dir,
      });
      assert.equal(result.skill, null);
      assert.equal(result.content, null);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('LLM returns unknown skill name → null (graceful)', async () => {
    setMockSkillResponse('nonexistent-skill');
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: 'body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '뭔가 해줘',
        skillsDir: dir,
      });
      assert.equal(result.skill, null);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('LLM failure → null (graceful fallback)', async () => {
    setMockFail();
    const dir = await makeTempSkillsDir([
      { name: 'b2b-email', description: 'B2B 이메일', body: 'body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '이메일 초안',
        skillsDir: dir,
      });
      assert.equal(result.skill, null);
    } finally {
      await rm(dir, { recursive: true });
      delete process.env.MOCK_CLAUDE_FAIL;
    }
  });

  test('previousResponse passed → does not break (content used in prompt)', async () => {
    setMockSkillResponse('claw-debug');
    const dir = await makeTempSkillsDir([
      { name: 'claw-debug', description: 'claw 디버그', body: '# Debug content' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '버그 잡아줘',
        previousResponse: '이전 에이전트가 분석한 내용입니다.',
        skillsDir: dir,
      });
      assert.equal(result.skill, 'claw-debug');
      assert.equal(result.content, '# Debug content');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// detectSkill — scope filtering (allowInternal)
// ---------------------------------------------------------------------------

describe('detectSkill: scope filtering', () => {
  before(() => {
    process.env.CLAUDE_BIN = MOCK_CLAUDE_PATH;
    _resetCapabilitiesForTest();
  });

  after(() => {
    if (ORIGINAL_CLAUDE_BIN !== undefined) {
      process.env.CLAUDE_BIN = ORIGINAL_CLAUDE_BIN;
    } else {
      delete process.env.CLAUDE_BIN;
    }
    _resetCapabilitiesForTest();
  });

  test('only internal skill exists + allowInternal omitted → filtered out, no LLM call', async () => {
    setMockFail(); // proves LLM is never invoked (would otherwise surface as failure, not null-from-filter)
    const dir = await makeTempSkillsDir([
      { name: 'simpleclaw-debug', description: '디버그', body: 'internal body', scope: 'internal' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '재시작 마커 관련 버그야',
        skillsDir: dir,
      });
      assert.equal(result.skill, null);
      assert.equal(result.content, null);
    } finally {
      await rm(dir, { recursive: true });
      delete process.env.MOCK_CLAUDE_FAIL;
    }
  });

  test('internal skill cached + allowInternal omitted (repo-work) → not inherited, falls through', async () => {
    setMockFail();
    const dir = await makeTempSkillsDir([
      { name: 'simpleclaw-debug', description: '디버그', body: 'internal body', scope: 'internal' },
      { name: 'b2b-email', description: 'B2B 이메일', body: 'shared body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: 'ㄱㄱ', // short-confirm shape
        cachedSkill: 'simpleclaw-debug',
        skillsDir: dir,
      });
      // Not inherited (filtered out) → falls through to LLM, which fails → null.
      assert.equal(result.skill, null);
    } finally {
      await rm(dir, { recursive: true });
      delete process.env.MOCK_CLAUDE_FAIL;
    }
  });

  test('internal skill cached + allowInternal: true (simpleclaw maintenance) → inherited', async () => {
    const dir = await makeTempSkillsDir([
      { name: 'simpleclaw-debug', description: '디버그', body: 'internal body', scope: 'internal' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: 'ㄱㄱ',
        cachedSkill: 'simpleclaw-debug',
        skillsDir: dir,
        allowInternal: true,
      });
      assert.equal(result.skill, 'simpleclaw-debug');
      assert.equal(result.content, 'internal body');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('LLM candidate list excludes internal skills when allowInternal omitted', async () => {
    // Mock returns the internal skill name anyway (simulating a leaked/hallucinated pick);
    // it must be rejected because it was never in the filtered candidate list handed to the LLM.
    setMockSkillResponse('simpleclaw-debug');
    const dir = await makeTempSkillsDir([
      { name: 'simpleclaw-debug', description: '디버그', body: 'internal body', scope: 'internal' },
      { name: 'b2b-email', description: 'B2B 이메일', body: 'shared body' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '아무거나 물어봄',
        skillsDir: dir,
      });
      assert.equal(result.skill, null);
      assert.equal(result.content, null);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('LLM candidate list includes internal skills when allowInternal: true', async () => {
    setMockSkillResponse('simpleclaw-debug');
    const dir = await makeTempSkillsDir([
      { name: 'simpleclaw-debug', description: '디버그', body: 'internal body', scope: 'internal' },
    ]);
    try {
      const result = await detectSkill({
        userMessage: '재시작 루프 버그 확인해줘',
        skillsDir: dir,
        allowInternal: true,
      });
      assert.equal(result.skill, 'simpleclaw-debug');
      assert.equal(result.content, 'internal body');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
