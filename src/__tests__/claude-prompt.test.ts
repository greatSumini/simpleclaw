import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPrompt } from '../claude.js';

describe('buildPrompt', () => {
  test('keeps systemAppend out of the user turn when --append-system-prompt is supported', () => {
    const out = buildPrompt('유저 메시지', '지시:\n- 한국어로 응답', { appendSystemPrompt: true });
    assert.equal(out, '유저 메시지');
  });

  test('falls back to inlining when the CLI lacks --append-system-prompt', () => {
    const out = buildPrompt('유저 메시지', '지시:\n- 한국어로 응답', { appendSystemPrompt: false });
    assert.equal(out, '유저 메시지\n\n---\n지시:\n- 한국어로 응답');
  });

  test('returns the bare prompt when systemAppend is empty', () => {
    assert.equal(buildPrompt('안녕', '', { appendSystemPrompt: false }), '안녕');
    assert.equal(buildPrompt('안녕', undefined, { appendSystemPrompt: false }), '안녕');
  });
});
