import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { routeMessage } from '../orchestrator/router.js';
import { runMigrations } from '../state/migrations.js';
import type { MessageContext } from '../messenger/types.js';
import type { AppConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_CH = 'ch-repo-001';
const SIMPLECLAW_CH = 'ch-simpleclaw-001';
const GENERAL_CH = 'ch-general-001';
const OWNER_ID = 'owner-001';

function makeConfig(): AppConfig {
  const dataDir = path.join(os.tmpdir(), `simpleclaw-router-test-${process.pid}`);
  return {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      GH_TOKEN: 'ghp',
      DISCORD_BOT_TOKEN: 'discord-tok',
      DISCORD_APPLICATION_ID: 'app-id',
      DISCORD_PUBLIC_KEY: 'pub-key',
      DISCORD_GUILD_ID: 'guild-id',
      DISCORD_CHANNEL_GENERAL: GENERAL_CH,
      DISCORD_CHANNEL_SIMPLECLAW: SIMPLECLAW_CH,
      DISCORD_CHANNEL_MAIL_ALERTS: REPO_CH,
      DISCORD_OWNER_USER_ID: OWNER_ID,
      GMAIL_CLIENT_ID: '',
      GMAIL_CLIENT_SECRET: '',
      MAIL_POLL_INTERVAL_SEC: 600,
      IMESSAGE_ENABLED: false,
      IMESSAGE_POLL_INTERVAL_SEC: 60,
      DASHBOARD_PORT: 3200,
      DASHBOARD_SECRET: 'test-secret-xx',
      DATA_DIR: dataDir,
      LOGS_DIR: path.join(dataDir, 'logs'),
      WIKI_DIR: path.join(os.tmpdir(), 'coding-agent-wiki'),
    },
    repoChannels: [
      {
        channelName: 'vmc-context-hub',
        channelId: REPO_CH,
        fullName: 'vibemafiaclub/context-hub',
        localPath: '/tmp/repos/vibemafiaclub/context-hub',
        category: 'code',
        description: 'test repo',
      },
    ],
    generalChannelId: GENERAL_CH,
    mailAlertChannelId: REPO_CH,
    simpleclawChannelId: SIMPLECLAW_CH,
    wikiChannelId: undefined,
    wikiDir: path.join(os.tmpdir(), 'coding-agent-wiki'),
    simpleclawRepoPath: '/tmp/repos/simpleclaw',
    vmcDigest: null,
    imessageEnabled: false,
    imessageAlertChannelId: GENERAL_CH,
    gmail: [],
    paths: {
      dataDir,
      logsDir: path.join(dataDir, 'logs'),
      dbFile: path.join(dataDir, 'simpleclaw.db'),
    },
  };
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    platform: 'discord',
    channelId: GENERAL_CH,
    threadId: null,
    authorId: OWNER_ID,
    authorName: 'testuser',
    text: 'hello',
    isMention: true,
    isDm: false,
    isBot: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — only the pure early-return paths (no Claude calls)
// ---------------------------------------------------------------------------

describe('routeMessage: early-return paths', () => {
  test('bot author → ignore', async () => {
    const config = makeConfig();
    const db = makeDb();
    const result = await routeMessage({
      ctx: makeCtx({ isBot: true }),
      config,
      db,
    });
    assert.equal(result.kind, 'ignore');
    assert.match(result.reason, /bot/);
    db.close();
  });

  test('repo-locked channel → repo-work (no Claude)', async () => {
    const config = makeConfig();
    const db = makeDb();
    const result = await routeMessage({
      ctx: makeCtx({ channelId: REPO_CH, isMention: false }),
      config,
      db,
    });
    assert.equal(result.kind, 'repo-work');
    assert.equal(result.repo.fullName, 'vibemafiaclub/context-hub');
    db.close();
  });

  test('simpleclaw maintenance channel → simpleclaw-maintenance (no Claude)', async () => {
    const config = makeConfig();
    const db = makeDb();
    const result = await routeMessage({
      ctx: makeCtx({ channelId: SIMPLECLAW_CH }),
      config,
      db,
    });
    assert.equal(result.kind, 'simpleclaw-maintenance');
    db.close();
  });

  test('general channel without mention or thread → ignore', async () => {
    const config = makeConfig();
    const db = makeDb();
    const result = await routeMessage({
      ctx: makeCtx({ channelId: GENERAL_CH, isMention: false, threadId: null }),
      config,
      db,
    });
    assert.equal(result.kind, 'ignore');
    assert.match(result.reason, /without mention/);
    db.close();
  });

  test('general channel in a thread (no mention) → proceeds to classify (not ignore)', async () => {
    const config = makeConfig();
    const db = makeDb();
    // Has threadId → classification starts. We expect it NOT to short-circuit as ignore.
    // The classify call will fail (no Claude in tests), so result will be 'ignore' with 'classifier failed',
    // NOT 'general channel without mention'.
    const result = await routeMessage({
      ctx: makeCtx({ channelId: GENERAL_CH, isMention: false, threadId: 'thread-001' }),
      config,
      db,
    });
    // Must NOT be the early-return ignore for "without mention"
    if (result.kind === 'ignore') {
      assert.ok(!/without mention/.test(result.reason), `unexpected early-return reason: ${result.reason}`);
    }
    db.close();
  });

  test('unknown channel (not repo, not claw, not general) → ignore', async () => {
    const config = makeConfig();
    const db = makeDb();
    const result = await routeMessage({
      ctx: makeCtx({ channelId: 'ch-unknown-999' }),
      config,
      db,
    });
    assert.equal(result.kind, 'ignore');
    assert.match(result.reason, /not registered/);
    db.close();
  });
});

describe('MockMessengerAdapter', () => {
  test('records postMailAlert calls', async () => {
    const { MockMessengerAdapter } = await import('./mocks/messenger-adapter.js');
    const mock = new MockMessengerAdapter();
    assert.equal(mock.platform, 'mock');

    const result = await mock.postMailAlert({
      channelId: 'ch-1',
      threadName: 'Test Thread',
      initialMessage: 'hello',
    });

    assert.equal(mock.calls.postMailAlert.length, 1);
    assert.equal(mock.calls.postMailAlert[0]?.channelId, 'ch-1');
    assert.equal(result.threadId, 'mock-thread-1');
  });

  test('records postToChannel calls', async () => {
    const { MockMessengerAdapter } = await import('./mocks/messenger-adapter.js');
    const mock = new MockMessengerAdapter();
    await mock.postToChannel('ch-2', 'some message');
    assert.equal(mock.calls.postToChannel.length, 1);
    assert.equal(mock.calls.postToChannel[0]?.content, 'some message');
  });

  test('reset clears all recorded calls', async () => {
    const { MockMessengerAdapter } = await import('./mocks/messenger-adapter.js');
    const mock = new MockMessengerAdapter();
    await mock.postToChannel('ch-1', 'msg');
    mock.reset();
    assert.equal(mock.calls.postToChannel.length, 0);
  });
});
