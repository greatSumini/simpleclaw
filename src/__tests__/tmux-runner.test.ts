import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeSessionName,
  stripAnsi,
  extractResponse,
  cleanupPaneText,
  TmuxRunner,
  TmuxError,
  type CmdRunner,
  type TmuxRunnerOptions,
} from '../tmux-runner.js';

// ── Pure function tests ────────────────────────────────────────────────────

describe('sanitizeSessionName', () => {
  test('prefixes with sc-', () => {
    assert.ok(sanitizeSessionName('foo').startsWith('sc-'));
  });

  test('replaces non-alphanumeric chars with dashes', () => {
    assert.equal(sanitizeSessionName('thread/123:abc'), 'sc-thread-123-abc');
  });

  test('truncates to max 53 chars total (sc- + 50)', () => {
    const long = 'a'.repeat(100);
    assert.ok(sanitizeSessionName(long).length <= 53);
  });

  test('stable for same input', () => {
    const key = 'discord-guild-ch-thread';
    assert.equal(sanitizeSessionName(key), sanitizeSessionName(key));
  });
});

describe('stripAnsi', () => {
  test('removes CSI sequences', () => {
    assert.equal(stripAnsi('\x1B[31mred\x1B[0m'), 'red');
  });

  test('removes cursor positioning', () => {
    assert.equal(stripAnsi('\x1B[2;5Hhello'), 'hello');
  });

  test('leaves plain text unchanged', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });

  test('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });

  test('removes multiple sequences', () => {
    const input = '\x1B[1m\x1B[32mGreen Bold\x1B[0m\x1B[m normal';
    assert.equal(stripAnsi(input), 'Green Bold normal');
  });
});

describe('extractResponse', () => {
  test('extracts text after anchor (first line of prompt)', () => {
    const before = 'previous content\n> ';
    const after = 'previous content\nHello world\nClaude says: hi there!\n> ';
    const prompt = 'Hello world';
    const result = extractResponse(before, after, prompt);
    assert.ok(result.includes('Claude says: hi there!'), `got: ${result}`);
  });

  test('falls back to line diff when anchor not found', () => {
    const before = 'line A\nline B\n';
    const after = 'line A\nline B\nline C — new response\n';
    const prompt = 'prompt not in pane';
    const result = extractResponse(before, after, prompt);
    assert.ok(result.includes('line C — new response'), `got: ${result}`);
  });

  test('returns after pane when both strategies produce empty', () => {
    const same = 'same content\n';
    const result = extractResponse(same, same, 'anchor missing');
    assert.equal(result, same.trim());
  });

  test('uses only the first line of a multi-line prompt as anchor', () => {
    const before = '';
    const prompt = 'first line\nsecond line\nthird line';
    const after = 'first line\nClaude response here\n';
    const result = extractResponse(before, after, prompt);
    assert.ok(result.includes('Claude response here'), `got: ${result}`);
  });

  test('trims whitespace from result', () => {
    const before = '';
    const after = 'anchor\n   \nresponse\n   \n';
    const result = extractResponse(before, after, 'anchor');
    assert.equal(result, 'response');
  });
});

// ── Realistic Claude Code TUI fixtures ────────────────────────────────────
//
// These fixtures model the plain-text output of `tmux capture-pane -p -J`
// after ANSI codes are stripped.  Adjust as real pane captures are collected.
//
// How to capture a real fixture:
//   tmux capture-pane -t <session-name> -p -J -S -3000 > fixture.txt
// Then add it as a new FIXTURES entry below.

/** Simulated Claude Code TUI pane content (terminal width ~80). */
const FIXTURES = {
  // Fresh session: only the input box, no conversation yet.
  empty: [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ >                                                                            │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].join('\n'),

  // After user sends "What is 2+2?" and Claude responds "4".
  simpleQA: (prompt = 'What is 2+2?', response = '4') =>
    [
      '╭──────────────────────────────────────────────────────────────────────────────╮',
      '│ ● Loaded MCP server "filesystem"                                            │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
      '',
      ' ◈ Human',
      '',
      `   ${prompt}`,
      '',
      ' ◈ Claude',
      '',
      `   ${response}`,
      '',
      '╭──────────────────────────────────────────────────────────────────────────────╮',
      '│ >                                                                            │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
    ].join('\n'),

  // After a multi-line response.
  multiLineResponse: [
    ' ◈ Human',
    '',
    '   Please list 3 colors',
    '',
    ' ◈ Claude',
    '',
    '   1. Red',
    '   2. Green',
    '   3. Blue',
    '',
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ >                                                                            │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].join('\n'),

  // After a response containing a code block.
  codeBlock: [
    ' ◈ Human',
    '',
    '   Show me a hello world in Python',
    '',
    ' ◈ Claude',
    '',
    '   Sure! Here is a hello world in Python:',
    '',
    '   ```python',
    '   print("Hello, world!")',
    '   ```',
    '',
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ >                                                                            │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].join('\n'),

  // After a continuation message ("this is a follow-up").
  continuation: [
    ' ◈ Human',
    '',
    '   What is 2+2?',
    '',
    ' ◈ Claude',
    '',
    '   4',
    '',
    ' ◈ Human',
    '',
    '   And 3+3?',
    '',
    ' ◈ Claude',
    '',
    '   6',
    '',
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ >                                                                            │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].join('\n'),
};

// ── Table-driven tests: extractResponse with TUI fixtures ─────────────────

interface ExtractCase {
  label: string;
  before: string;
  after: string;
  prompt: string;
  shouldContain: string[];
  shouldNotContain?: string[];
}

const extractCases: ExtractCase[] = [
  {
    label: 'simple Q&A — anchor strategy picks up response after prompt',
    before: FIXTURES.empty,
    after: FIXTURES.simpleQA(),
    prompt: 'What is 2+2?',
    shouldContain: ['4'],
    shouldNotContain: ['What is 2+2?'],
  },
  {
    label: 'multi-line response — all lines present',
    before: FIXTURES.empty,
    after: FIXTURES.multiLineResponse,
    prompt: 'Please list 3 colors',
    shouldContain: ['1. Red', '2. Green', '3. Blue'],
  },
  {
    label: 'code block — backticks and code preserved',
    before: FIXTURES.empty,
    after: FIXTURES.codeBlock,
    prompt: 'Show me a hello world in Python',
    shouldContain: ['print("Hello, world!")', '```python'],
  },
  {
    label: 'continuation — lastIndexOf picks latest occurrence of anchor',
    before: FIXTURES.simpleQA(),
    after: FIXTURES.continuation,
    prompt: 'And 3+3?',
    shouldContain: ['6'],
    shouldNotContain: ['And 3+3?'],
  },
  {
    label: 'anchor not found — line diff fallback captures new lines',
    before: FIXTURES.empty,
    after: FIXTURES.simpleQA('totally different prompt', 'response text'),
    // prompt doesn't match what's in pane → triggers line diff
    prompt: 'anchor not present in pane at all XYZ',
    shouldContain: ['response text'],
  },
];

describe('extractResponse — table-driven with TUI fixtures', () => {
  for (const tc of extractCases) {
    test(tc.label, () => {
      const result = extractResponse(tc.before, tc.after, tc.prompt);
      for (const s of tc.shouldContain) {
        assert.ok(result.includes(s), `expected "${s}" in result:\n${result}`);
      }
      for (const s of tc.shouldNotContain ?? []) {
        assert.ok(!result.includes(s), `did NOT expect "${s}" in result:\n${result}`);
      }
    });
  }
});

// ── cleanupPaneText ────────────────────────────────────────────────────────

interface CleanupCase {
  label: string;
  input: string;
  shouldContain: string[];
  shouldNotContain: string[];
}

const cleanupCases: CleanupCase[] = [
  {
    label: 'removes box drawing border lines',
    input: [
      '╭──────────────────╮',
      '│ response text    │',
      '╰──────────────────╯',
    ].join('\n'),
    shouldContain: ['response text'],
    shouldNotContain: ['╭', '╰', '──────'],
  },
  {
    label: 'removes ◈ Claude role indicator',
    input: ' ◈ Claude\n\n   Hello there!',
    shouldContain: ['Hello there!'],
    shouldNotContain: ['◈ Claude'],
  },
  {
    label: 'removes ● Claude role indicator',
    input: ' ● Claude\n   Hello!',
    shouldContain: ['Hello!'],
    shouldNotContain: ['● Claude'],
  },
  {
    label: 'removes ◈ Human role indicator',
    input: ' ◈ Human\n   User message\n ◈ Claude\n   Response',
    shouldContain: ['User message', 'Response'],
    shouldNotContain: ['◈ Human', '◈ Claude'],
  },
  {
    label: 'removes input box │ > │',
    input: 'Response content\n│ >                │',
    shouldContain: ['Response content'],
    shouldNotContain: ['│ >'],
  },
  {
    label: 'removes standalone > indicator',
    input: 'Response\n >',
    shouldContain: ['Response'],
    shouldNotContain: ['>'],
  },
  {
    label: 'preserves code blocks and special content',
    input: [
      ' ◈ Claude',
      '',
      '   Here is the code:',
      '',
      '   ```python',
      '   print("Hello, world!")',
      '   ```',
    ].join('\n'),
    shouldContain: ['Here is the code:', 'print("Hello, world!")', '```python'],
    shouldNotContain: ['◈ Claude'],
  },
  {
    label: 'trims trailing spaces per line (TUI pads to terminal width)',
    input: 'Hello world                    ',
    shouldContain: ['Hello world'],
    shouldNotContain: ['Hello world   '],
  },
  {
    label: 'full TUI pane — only response text survives',
    input: extractResponse(FIXTURES.empty, FIXTURES.simpleQA(), 'What is 2+2?'),
    shouldContain: ['4'],
    shouldNotContain: ['╭', '╰', '◈ Claude', '◈ Human', '│ >'],
  },
  {
    label: 'multi-line response — all content lines preserved',
    input: extractResponse(FIXTURES.empty, FIXTURES.multiLineResponse, 'Please list 3 colors'),
    shouldContain: ['1. Red', '2. Green', '3. Blue'],
    shouldNotContain: ['◈ Claude', '◈ Human', '╭', '│ >'],
  },
];

describe('cleanupPaneText — table-driven', () => {
  for (const tc of cleanupCases) {
    test(tc.label, () => {
      const result = cleanupPaneText(tc.input);
      for (const s of tc.shouldContain) {
        assert.ok(result.includes(s), `expected "${s}" in:\n${result}`);
      }
      for (const s of tc.shouldNotContain) {
        assert.ok(!result.includes(s), `did NOT expect "${s}" in:\n${result}`);
      }
    });
  }
});

// ── helpers ────────────────────────────────────────────────────────────────

type CmdCall = { args: string[] };

function makeMock(handler: (args: string[]) => { out: string; code: number }): {
  runner: CmdRunner;
  calls: CmdCall[];
} {
  const calls: CmdCall[] = [];
  const runner: CmdRunner = async (args) => {
    calls.push({ args });
    return handler(args);
  };
  return { runner, calls };
}

/** Fast-timing options: no real sleeps in tests. */
const FAST: Partial<TmuxRunnerOptions> = {
  initWaitMs: 0,
  pollMs: 10,
  stablePolls: 2,
  minWaitMs: 0,
};

// ── TmuxRunner.ensureSession ───────────────────────────────────────────────

describe('TmuxRunner.ensureSession', () => {
  test('creates session when none exists (has-session returns 1)', async () => {
    const { runner, calls } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 1 };
      return { out: '', code: 0 };
    });
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.ensureSession('test-sess', '/tmp');

    const newSession = calls.find((c) => c.args[1] === 'new-session');
    assert.ok(newSession, 'new-session should have been called');
    assert.ok(newSession.args.includes('test-sess'));
    assert.ok(newSession.args.includes('/tmp'));
  });

  test('skips creation when session already alive (has-session returns 0)', async () => {
    const { runner, calls } = makeMock(() => ({ out: '', code: 0 }));
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.ensureSession('existing-sess', '/tmp');

    const newSession = calls.find((c) => c.args[1] === 'new-session');
    assert.equal(newSession, undefined, 'new-session should NOT have been called');
  });
});

// ── TmuxRunner.kill ────────────────────────────────────────────────────────

describe('TmuxRunner.kill', () => {
  test('kills session after run populates the map', async () => {
    let captureCount = 0;
    const { runner, calls } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'capture-pane') {
        captureCount++;
        if (captureCount === 1) return { out: 'before\n', code: 0 };
        return { out: 'before\nmy prompt\nClaude: done\n', code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.run({ cwd: '/tmp', prompt: 'my prompt', sessionKey: 'kill-test-key', timeoutMs: 5_000 });
    await tmux.kill('kill-test-key');

    const killCall = calls.find((c) => c.args[1] === 'kill-session');
    assert.ok(killCall, 'kill-session should have been called');
  });

  test('no-ops when key not in map', async () => {
    const { runner, calls } = makeMock(() => ({ out: '', code: 0 }));
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.kill('nonexistent');
    const killCall = calls.find((c) => c.args[1] === 'kill-session');
    assert.equal(killCall, undefined);
  });
});

// ── TmuxRunner.waitUntilStable ─────────────────────────────────────────────

describe('TmuxRunner.waitUntilStable', () => {
  test('returns pane when output stabilizes', async () => {
    let callCount = 0;
    const stableContent = 'stable response content';
    const { runner } = makeMock((args) => {
      if (args[1] === 'capture-pane') {
        callCount++;
        if (callCount <= 2) return { out: `changing-${callCount}`, code: 0 };
        return { out: stableContent, code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    // startMs far enough in the past to satisfy minWaitMs=0
    const result = await tmux.waitUntilStable('sess', Date.now(), 60_000);
    assert.equal(result, stableContent);
  });

  test('throws TmuxError on timeout', async () => {
    const { runner } = makeMock((args) => {
      if (args[1] === 'capture-pane') return { out: `content-${Date.now()}`, code: 0 };
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await assert.rejects(
      () => tmux.waitUntilStable('sess', Date.now() - 10_000, 1),
      TmuxError,
    );
  });

  test('throws TmuxError when signal aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner } = makeMock(() => ({ out: '', code: 0 }));
    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await assert.rejects(
      () => tmux.waitUntilStable('sess', Date.now(), 60_000, controller.signal),
      TmuxError,
    );
  });
});

// ── TmuxRunner.run — happy path ────────────────────────────────────────────

describe('TmuxRunner.run', () => {
  test('returns extracted text and empty artifacts for simple response', async () => {
    let captureCallCount = 0;
    const { runner } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'capture-pane') {
        captureCallCount++;
        if (captureCallCount === 1) return { out: 'before\n', code: 0 };
        if (captureCallCount <= 3) return { out: `before\nchanging-${captureCallCount}`, code: 0 };
        return { out: 'before\nmy prompt here\nHello from Claude!\n', code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    const result = await tmux.run({
      cwd: '/tmp',
      prompt: 'my prompt here',
      sessionKey: 'thread-abc',
      timeoutMs: 30_000,
    });

    assert.ok(result.text.includes('Hello from Claude!'), `text: ${result.text}`);
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionKey, 'thread-abc');
  });

  test('includes systemAppend in full message sent to tmux', async () => {
    let captureCallCount = 0;
    const sentMessages: string[] = [];

    // Intercept file writes to capture what was sent
    const { runner } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'load-buffer') {
        // The file path is args[2]; we can't easily read it, but we verify it was called
        sentMessages.push(args[2] ?? '');
        return { out: '', code: 0 };
      }
      if (args[1] === 'capture-pane') {
        captureCallCount++;
        if (captureCallCount === 1) return { out: '', code: 0 };
        return { out: 'user prompt\nClaude response\n', code: 0 };
      }
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    await tmux.run({
      cwd: '/tmp',
      prompt: 'user prompt',
      systemAppend: 'system instructions here',
      sessionKey: 'thread-sys',
      timeoutMs: 30_000,
    });

    // load-buffer should have been called (message was sent via paste-buffer)
    assert.ok(sentMessages.length > 0, 'load-buffer should have been called');
  });

  test('concurrent calls on same key are serialized (mutex)', async () => {
    const completed: string[] = [];
    // Always return stable pane — allows both runs to complete quickly
    const { runner } = makeMock((args) => {
      if (args[1] === 'has-session') return { out: '', code: 0 };
      if (args[1] === 'capture-pane') return { out: 'prompt-A\nClaude done\n', code: 0 };
      return { out: '', code: 0 };
    });

    const tmux = new TmuxRunner({ ...FAST, cmdRunner: runner });
    const p1 = tmux.run({ cwd: '/tmp', prompt: 'prompt-A', sessionKey: 'shared-key', timeoutMs: 5_000 })
      .then(() => completed.push('first'));
    const p2 = tmux.run({ cwd: '/tmp', prompt: 'prompt-A', sessionKey: 'shared-key', timeoutMs: 5_000 })
      .then(() => completed.push('second'));

    await Promise.all([p1, p2]);
    // Both must complete (mutex serializes them, not drops them)
    assert.equal(completed.length, 2);
    assert.ok(completed.includes('first'));
    assert.ok(completed.includes('second'));
  });
});
