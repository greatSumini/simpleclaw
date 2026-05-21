import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisPrompt } from '../orchestrator/auto-analysis.js';

describe('buildAnalysisPrompt', () => {
  test('includes repo in header line', () => {
    const prompt = buildAnalysisPrompt('thread-001', '사용자: 안녕', 'vibemafiaclub/context-hub');
    assert.ok(prompt.includes('repo: vibemafiaclub/context-hub'), 'header should contain repo');
  });

  test('includes repo in analysis instruction', () => {
    const prompt = buildAnalysisPrompt('thread-001', '(대화 기록 없음)', 'greatSumini/simpleclaw');
    assert.ok(prompt.includes('greatSumini/simpleclaw'), 'analysis instruction should reference repo');
  });

  test('includes threadId in header', () => {
    const prompt = buildAnalysisPrompt('thread-xyz', '(대화 기록 없음)', 'foo/bar');
    assert.ok(prompt.includes('thread: thread-xyz'));
  });

  test('includes transcript in output', () => {
    const transcript = '[2026-05-07 10:00:00] 사용자: 테스트 메시지입니다.';
    const prompt = buildAnalysisPrompt('t-1', transcript, 'foo/bar');
    assert.ok(prompt.includes(transcript));
  });

  test('different repos produce different prompts', () => {
    const p1 = buildAnalysisPrompt('t', '...', 'vibemafiaclub/context-hub');
    const p2 = buildAnalysisPrompt('t', '...', 'greatSumini/simpleclaw');
    assert.notEqual(p1, p2);
  });
});
