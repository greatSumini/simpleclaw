import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isMemoMessage } from '../orchestrator/memo.js';

describe('isMemoMessage', () => {
  test('마커로 시작하면 기록으로 판정', () => {
    assert.equal(isMemoMessage('📝 오늘 해야할 일'), true);
    assert.equal(isMemoMessage('📌 사업 방향성 고민'), true);
    assert.equal(isMemoMessage('🗒️ 메모'), true);
    assert.equal(isMemoMessage('✍️ 초안'), true);
    assert.equal(isMemoMessage('#기록 이강진님 상담'), true);
    assert.equal(isMemoMessage('#메모 ASC 강연'), true);
  });

  test('마커 앞 공백/개행은 무시', () => {
    assert.equal(isMemoMessage('   \n📝 오늘 할 일'), true);
  });

  test('마커만 있어도 기록', () => {
    assert.equal(isMemoMessage('📝'), true);
  });

  test('실제 사고를 유발했던 메모 원문 — 마커를 붙이면 차단된다', () => {
    const memo = [
      '📝 **오늘 해야할 일**',
      '- 도메인스토리텔링 관련 교육자료 준비',
      '- VIBE PT 학생별 페이지 만들기',
      '- ASC 강연 주제 확정해서 보내기',
      '- 피아노 연습',
    ].join('\n');
    assert.equal(isMemoMessage(memo), true);
  });

  test('마커가 없으면 평소대로 처리', () => {
    assert.equal(isMemoMessage('**오늘 해야할 일**\n- 자료 준비'), false);
    assert.equal(isMemoMessage('워크숍 자료 만들어줘'), false);
    assert.equal(isMemoMessage(''), false);
    assert.equal(isMemoMessage('   '), false);
  });

  test('본문 중간·끝의 마커는 인정하지 않는다 (지시가 조용히 무시되는 것을 막기 위해)', () => {
    assert.equal(isMemoMessage('이거 정리해줘 📝'), false);
    assert.equal(isMemoMessage('메일 보내줘, 그리고 📌 아래 내용 참고'), false);
  });
});
