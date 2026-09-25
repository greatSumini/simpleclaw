import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveEngineModel } from '../config.js';

describe('resolveEngineModel', () => {
  test('passes the alias through for claude-code (explicit or default engine)', () => {
    assert.equal(resolveEngineModel({ model: 'sonnet' }), 'sonnet');
    assert.equal(resolveEngineModel({ engine: 'claude-code', model: 'haiku' }), 'haiku');
  });

  test('no model configured → undefined (CLI default, the pre-existing behaviour)', () => {
    assert.equal(resolveEngineModel({}), undefined);
    assert.equal(resolveEngineModel({ engine: 'claude-code' }), undefined);
  });

  test('drops the alias for engines that would choke on it', () => {
    // codex --model takes OpenAI names; tmux drives an interactive pane with no such flag.
    assert.equal(resolveEngineModel({ engine: 'codex', model: 'opus' }), undefined);
    assert.equal(resolveEngineModel({ engine: 'tmux', model: 'opus' }), undefined);
  });
});
