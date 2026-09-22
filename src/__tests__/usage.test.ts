import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consumeJsonObject, newAccumulator, type StreamJsonObject } from '../claude.js';
import { buildUsageFooter } from '../state/usage.js';

function parse(events: StreamJsonObject[]) {
  const acc = newAccumulator();
  for (const e of events) consumeJsonObject(acc, e);
  return acc;
}

const rateLimitEvent = (fiveHour: number, sevenDay: number): StreamJsonObject => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: 1790046600 },
      seven_day: { utilization: sevenDay, resetsAt: 1790294400 },
    },
  },
});

describe('stream-json usage parsing', () => {
  test('last rate_limit_event wins', () => {
    const acc = parse([rateLimitEvent(0.19, 0.2), rateLimitEvent(0.18, 0.21)]);
    assert.deepEqual(acc.rateLimits, {
      fiveHour: { utilization: 0.18, resetsAt: 1790046600 },
      sevenDay: { utilization: 0.21, resetsAt: 1790294400 },
    });
  });

  test('rate_limit_event without unifiedWindows leaves rateLimits unset', () => {
    const acc = parse([{ type: 'rate_limit_event', rate_limit_info: {} }]);
    assert.equal(acc.rateLimits, undefined);
  });

  test('subagent assistant events do not overwrite the main-thread context fill', () => {
    // Shape taken from a real run where the Agent tool read a large file.
    const acc = parse([
      { type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 3135, cache_read_input_tokens: 23982 } } },
      { type: 'assistant', parent_tool_use_id: 'toolu_x', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 27259, cache_read_input_tokens: 16800 } } },
    ]);
    assert.equal(acc.contextWindowUsed, 27119);
  });

  test('result iterations[-1] (incl. output) is the context fill; modelUsage gives the max', () => {
    const acc = parse([
      { type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 769, cache_read_input_tokens: 27117 } } },
      {
        type: 'result',
        total_cost_usd: 0.27,
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 12762,
          cache_read_input_tokens: 35083,
          iterations: [{ input_tokens: 2, cache_creation_input_tokens: 769, cache_read_input_tokens: 27117, output_tokens: 274 }],
        },
        modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } },
      },
    ]);
    assert.equal(acc.contextWindowUsed, 28162);
    assert.equal(acc.contextWindowMax, 1_000_000);
    assert.equal(acc.costUsd, 0.27);
  });
});

describe('buildUsageFooter', () => {
  const now = 1790000000 * 1000;
  const base = { sessionId: 's', costUsd: 1, contextWindowUsed: 158_632, contextWindowMax: 1_000_000 };

  test('shows the real account quota utilization', () => {
    const footer = buildUsageFooter(
      {
        ...base,
        rateLimits: {
          fiveHour: { utilization: 0.19, resetsAt: 1790046600 },
          sevenDay: { utilization: 0.2, resetsAt: 1790294400 },
        },
      },
      now,
    );
    assert.equal(footer, '[context usage / current 16% (159K/1.0M) / 5h 19% / weekly 20%]');
  });

  test('n/a when the engine reported no quota data (codex/tmux) or the reading is past its reset', () => {
    assert.equal(
      buildUsageFooter({ ...base, contextWindowMax: 0 }, now),
      '[context usage / current n/a / 5h n/a / weekly n/a]',
    );
    const stale = buildUsageFooter(
      { ...base, rateLimits: { fiveHour: { utilization: 0.9, resetsAt: 1789999999 } } },
      now,
    );
    assert.equal(stale, '[context usage / current 16% (159K/1.0M) / 5h n/a / weekly n/a]');
  });
});
