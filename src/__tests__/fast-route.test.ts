import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  askJev,
  buildJevRequest,
  parseRouteFile,
  pickRoute,
  runRoute,
  type FastRouteFile,
} from '../orchestrator/fast-route.js';

const fuel = { name: 'fuel-nearby', when: '현재 위치 주변 주유소', argv: ['uv', 'run', 'find.py'] };

function file(overrides: Partial<FastRouteFile> = {}): FastRouteFile {
  return { mode: 'on', minConfidence: 0.8, routes: [fuel], ...overrides };
}

describe('parseRouteFile', () => {
  test('mode·minConfidence 기본값 적용', () => {
    const r = parseRouteFile(JSON.stringify({ routes: [fuel] }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.file.mode, 'on');
      assert.equal(r.file.minConfidence, 0.8);
    }
  });

  test('잘못된 JSON·빈 routes·none 이름·중복 이름은 거부', () => {
    assert.equal(parseRouteFile('{').ok, false);
    assert.equal(parseRouteFile(JSON.stringify({ routes: [] })).ok, false);
    assert.equal(parseRouteFile(JSON.stringify({ routes: [{ ...fuel, name: 'none' }] })).ok, false);
    assert.equal(parseRouteFile(JSON.stringify({ routes: [fuel, fuel] })).ok, false);
    assert.equal(parseRouteFile(JSON.stringify({ routes: [{ ...fuel, argv: [] }] })).ok, false);
  });
});

describe('buildJevRequest', () => {
  test('route 이름 + none이 Choice 옵션으로 들어간다', () => {
    const req = buildJevRequest('주변 주유소 찾아줘', [fuel]) as {
      state: string;
      questions: { route: { type: string; criteria: Record<string, string> } };
    };
    assert.equal(req.state, '주변 주유소 찾아줘');
    assert.equal(req.questions.route.type, 'choice');
    assert.deepEqual(Object.keys(req.questions.route.criteria), ['fuel-nearby', 'none']);
  });
});

describe('pickRoute', () => {
  test('기준 이상이면 route 선택', () => {
    assert.equal(pickRoute({ choice: 'fuel-nearby', confidence: 0.96 }, file())?.name, 'fuel-nearby');
  });

  test('none·기준 미달·미등록 이름은 Claude', () => {
    assert.equal(pickRoute({ choice: 'none', confidence: 1 }, file()), null);
    assert.equal(pickRoute({ choice: 'fuel-nearby', confidence: 0.5 }, file()), null);
    assert.equal(pickRoute({ choice: 'ghost', confidence: 1 }, file()), null);
  });
});

describe('askJev', () => {
  test('choice·confidence 추출', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ answers: { route: { type: 'choice', choice: 'fuel-nearby', confidence: 0.9 } } }),
      )) as typeof fetch;
    assert.deepEqual(await askJev('x', [fuel], 'k', fakeFetch), { choice: 'fuel-nearby', confidence: 0.9 });
  });

  test('HTTP 오류·형식 오류는 throw (호출자가 Claude로 fallback)', async () => {
    const err401 = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    await assert.rejects(askJev('x', [fuel], 'k', err401));
    const malformed = (async () => new Response(JSON.stringify({ answers: {} }))) as typeof fetch;
    await assert.rejects(askJev('x', [fuel], 'k', malformed));
  });
});

describe('runRoute', () => {
  const node = process.execPath;

  test('stdout이 응답 텍스트', async () => {
    const r = await runRoute({ ...fuel, argv: [node, '-e', 'console.log("  결과  ")'] }, process.cwd());
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.text, '결과');
  });

  test('exit≠0·빈 출력·타임아웃은 실패', async () => {
    const exit1 = await runRoute({ ...fuel, argv: [node, '-e', 'console.error("boom"); process.exit(1)'] }, process.cwd());
    assert.equal(exit1.ok, false);
    if (!exit1.ok) assert.match(exit1.error, /boom/);

    const empty = await runRoute({ ...fuel, argv: [node, '-e', ''] }, process.cwd());
    assert.equal(empty.ok, false);

    const slow = await runRoute({ ...fuel, argv: [node, '-e', 'setTimeout(()=>{}, 5000)'], timeoutMs: 200 }, process.cwd());
    assert.equal(slow.ok, false);
  });

  test('SimpleClaw 비밀 env는 스크립트에 전달되지 않는다', async () => {
    process.env.DISCORD_BOT_TOKEN_TEST_LEAK = 'secret';
    const r = await runRoute(
      { ...fuel, argv: [node, '-e', 'console.log(process.env.DISCORD_BOT_TOKEN_TEST_LEAK ?? "clean")'] },
      process.cwd(),
    );
    delete process.env.DISCORD_BOT_TOKEN_TEST_LEAK;
    assert.equal(r.ok && r.text, 'clean');
  });
});
