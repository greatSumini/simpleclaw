import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProjectWizard,
  appendRepoToConfigFile,
  buildLocalPath,
  remoteMatches,
  renderPlan,
  toChannelName,
  validateRepoName,
  type ProjectPlan,
} from '../adapters/project-wizard.js';
import type { AppConfig, RepoEntry } from '../config.js';

test('validateRepoName: accepts GitHub-valid names', () => {
  for (const n of ['foo', 'Foo-Bar', 'a.b_c', 'x1']) assert.equal(validateRepoName(n), null, n);
});

test('validateRepoName: rejects empty, spaces, slashes, dot names, >100 chars', () => {
  for (const n of ['', 'has space', 'a/b', '.', '..', '한글', 'x'.repeat(101)]) {
    assert.notEqual(validateRepoName(n), null, n);
  }
});

test('toChannelName: lowercases and replaces dots', () => {
  assert.equal(toChannelName('My.Repo_X'), 'my-repo_x');
});

test('buildLocalPath: reposDir/scope/name', () => {
  assert.equal(buildLocalPath('/Users/me/repos', 'vibemafiaclub', 'foo'), '/Users/me/repos/vibemafiaclub/foo');
});

test('remoteMatches: https, ssh, token-embedded, .git suffix, case-insensitive', () => {
  assert.ok(remoteMatches('https://github.com/Vooster-AI/monorepo.git\n', 'vooster-ai/monorepo'));
  assert.ok(remoteMatches('git@github.com:greatSumini/life-os.git', 'greatSumini/life-os'));
  assert.ok(remoteMatches('https://x-access-token:abc@github.com/a/b', 'a/b'));
  assert.ok(!remoteMatches('https://github.com/a/bc.git', 'a/b'));
  assert.ok(!remoteMatches('https://github.com/HowToMakeHappy/lifesaju_kr.git', 'outsourcing/lifesaju_kr'));
});

test('appendRepoToConfigFile: appends once, preserves other keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
  const file = path.join(dir, 'simpleclaw.config.json');
  fs.writeFileSync(file, JSON.stringify({ repos: [], gmail: [{ email: 'a@b.c', label: 'x' }] }));
  const entry: RepoEntry = {
    channelName: 'foo',
    channelId: 'ch-1',
    fullName: 'o/foo',
    localPath: '/r/o/foo',
    category: 'code',
    description: '',
  };
  assert.equal(appendRepoToConfigFile(file, entry), true);
  assert.equal(appendRepoToConfigFile(file, entry), false);
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(saved.repos.length, 1);
  assert.equal(saved.gmail.length, 1);
  fs.rmSync(dir, { recursive: true });
});

test('renderPlan: shows existing vs new state', () => {
  const base: ProjectPlan = {
    id: 'x',
    scope: 'o',
    name: 'foo',
    fullName: 'o/foo',
    visibility: 'private',
    description: '',
    watchIssues: true,
    watchPrs: false,
    localPath: '/r/o/foo',
    channelName: 'foo',
    repoExists: false,
    localExists: false,
    existingChannelId: undefined,
    createdAt: 0,
  };
  const fresh = renderPlan(base);
  assert.match(fresh, /private, 신규 생성/);
  assert.match(fresh, /#foo \(신규 생성\)/);
  assert.match(fresh, /감시: 이슈/);
  const existing = renderPlan({ ...base, repoExists: true, existingChannelId: '123' });
  assert.match(existing, /이미 존재 — 연결만/);
  assert.match(existing, /<#123>/);
});

test('modal: builds valid Discord JSON with 5 components and configured scopes', () => {
  const config = {
    env: { DISCORD_OWNER_USER_ID: 'o', DISCORD_GUILD_ID: 'g' },
    projectWizard: { githubScopes: ['greatSumini', 'vibemafiaclub'], reposDir: '/r', channelCategoryId: undefined },
  } as unknown as AppConfig;
  const wizard = new ProjectWizard({ client: {} as never, config, db: {} as never, ipc: {} as never });
  const json = (wizard as unknown as { buildModal(): { toJSON(): { components: unknown[] } } }).buildModal().toJSON();
  assert.equal(json.components.length, 5);
  assert.match(JSON.stringify(json), /"value":"vibemafiaclub"/);
});
