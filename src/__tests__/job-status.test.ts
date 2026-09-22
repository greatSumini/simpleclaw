import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { detectsFollowUpPromise, formatJobStatus, isStatusQuestion } from '../orchestrator/job-status.js';
import type { BackgroundJobRow } from '../state/background-jobs.js';

describe('isStatusQuestion', () => {
  for (const q of ['다 했어?', '다했어?', '다 됐어?', '다했어', '끝났어?', '진행상황 어때?', '어디까지 했어?']) {
    test(`matches "${q}"`, () => assert.ok(isStatusQuestion(q)));
  }
  for (const q of ['다 했어? 그럼 업로드해줘', '다했으면 기존 영상 지우고 업로드', '녹음 다 했어', '진행해줘']) {
    test(`does not match "${q}"`, () => assert.ok(!isStatusQuestion(q)));
  }
});

describe('detectsFollowUpPromise', () => {
  const promises = [
    '렌더링이 백그라운드로 넘어갔습니다 — 완료되면 알려드릴게요.',
    '71개 재렌더링 진행 중입니다. 완료되면 재조립 및 업로드까지 이어가겠습니다.',
    '19/51 완료, 실패 없이 진행 중입니다. 계속 모니터링하며 대기하겠습니다.',
  ];
  const handOffs = [
    '로그인해주시면 그 이후 폼 제출은 제가 이어서 처리하겠습니다.',
    '자료 준비되면 알려주세요, 회신 초안 드릴게요.',
    '"완료되면 알려드릴게요" 같은 약속을 금지했습니다.',
    '업로드까지 전부 마쳤습니다.',
  ];
  for (const t of promises) test(`flags: ${t.slice(0, 30)}`, () => assert.ok(detectsFollowUpPromise(t)));
  for (const t of handOffs) test(`ignores: ${t.slice(0, 30)}`, () => assert.ok(!detectsFollowUpPromise(t)));
});

describe('formatJobStatus', () => {
  test('watch job shows condition-wait state and stays under the Discord limit', () => {
    const job: BackgroundJobRow = {
      id: 7,
      threadId: 't',
      description: '전사 대기',
      checkCmd: 'test -f x',
      cwd: '/tmp',
      doneMessage: 'ok',
      status: 'pending',
      createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      checkedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      attempts: 3,
      errorStreak: 0,
      errorNotified: false,
      lastError: 'exit 1',
      runToken: 'tok',
      pid: null,
      procStartedAt: null,
      jobDir: null,
      expiryWarned: false,
      reaped: false,
    };
    const out = formatJobStatus([job]);
    assert.match(out, /job #7 전사 대기 — 조건 대기 중 · 경과 1시간 30분/);
    assert.ok(out.length <= 1900);
  });
});
