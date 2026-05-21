#!/usr/bin/env tsx
/**
 * Interactive setup wizard for claw.
 * Run: pnpm run setup
 *
 * What it does:
 *   1. Reads simpleclaw.config.json to know how many Gmail accounts to prompt for
 *   2. Prompts for all required .env values
 *   3. Writes .env
 *   4. Generates a launchd plist (macOS only) and offers to bootstrap it
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rl = createInterface({ input, output });

async function ask(question: string, defaultValue = ''): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`  ${question}${hint}: `);
  return answer.trim() || defaultValue;
}

function header(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

interface DiscordAutoDetect {
  applicationId: string;
  guildId: string;
  generalChannelId: string;
  generalChannelName: string;
}

async function autoDetectDiscord(botToken: string): Promise<DiscordAutoDetect> {
  // 1. Application ID from bot user
  const meRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!meRes.ok) throw new Error(`봇 토큰이 유효하지 않습니다 (${meRes.status})`);
  const me = (await meRes.json()) as { id: string };
  const applicationId = me.id;

  // 2. Guild (server) the bot is in
  const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
    headers: { Authorization: `Bot ${botToken}` },
  });
  const guilds = (await guildsRes.json()) as Array<{ id: string; name: string }>;
  if (!Array.isArray(guilds) || guilds.length === 0) {
    throw new Error('봇이 서버에 초대되어 있지 않습니다. 봇을 Discord 서버에 먼저 초대해주세요.');
  }

  let guildId: string;
  if (guilds.length === 1) {
    guildId = guilds[0].id;
    console.log(`  → 서버 자동 선택: ${guilds[0].name}`);
  } else {
    console.log('  봇이 여러 서버에 있습니다:');
    guilds.forEach((g, i) => console.log(`    ${i + 1}. ${g.name} (${g.id})`));
    const choice = await ask(`  사용할 서버 번호 (1-${guilds.length})`, '1');
    guildId = guilds[Math.max(0, parseInt(choice, 10) - 1)].id;
  }

  // 3. Text channels — find '일반' or 'general', fallback to first
  const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  const channels = (await chRes.json()) as Array<{ id: string; name: string; type: number; position: number }>;
  const textChannels = channels
    .filter((c) => c.type === 0)
    .sort((a, b) => a.position - b.position);
  if (textChannels.length === 0) throw new Error('서버에 텍스트 채널이 없습니다.');

  const general =
    textChannels.find((c) => c.name === '일반' || c.name.toLowerCase().includes('general')) ??
    textChannels[0];
  console.log(`  → 일반 채널 자동 선택: #${general.name} (${general.id})`);

  return { applicationId, guildId, generalChannelId: general.id, generalChannelName: general.name };
}

async function main() {
  const clawDir = process.cwd();

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       SimpleClaw setup wizard        ║');
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`Working directory: ${clawDir}`);

  // ── Context Hub (optional first-time setup) ───────────────────────────────
  const configPath = path.join(clawDir, 'simpleclaw.config.json');
  const hasConfig = fs.existsSync(configPath);
  let hubChannelId = '';

  if (!hasConfig) {
    header('Context Hub (권장)');
    console.log('  context-hub는 이메일·캘린더·메모 등 범용 작업의 기본 허브 레포입니다.');
    console.log('  일반 채널에서 보내는 모든 메시지가 이 레포에서 실행됩니다.');
    console.log('  템플릿: https://github.com/greatSumini/context-hub-template\n');
    const createHub = await ask('context-hub를 지금 생성할까요? (y/n)', 'y');

    if (createHub.toLowerCase() === 'y') {
      let ghUser = '';
      try {
        ghUser = execSync('gh api user --jq .login 2>/dev/null', { encoding: 'utf-8' }).trim();
      } catch { /* gh not authed yet */ }
      const hubUser = await ask('GitHub 사용자명 또는 조직명', ghUser);
      const hubLocalPath = await ask('로컬 경로', path.join(process.env['HOME'] ?? '~', 'context-hub'));
      hubChannelId = await ask('Discord 채널 ID (일반 채널 — 이 채널의 모든 메시지가 허브로 라우팅됨)');

      console.log('\n  context-hub 레포 생성 중...');
      try {
        execSync(
          `gh repo create ${hubUser}/context-hub --private --template greatSumini/context-hub-template`,
          { stdio: 'inherit' },
        );
        execSync(`gh repo clone ${hubUser}/context-hub "${hubLocalPath}"`, { stdio: 'inherit' });
        console.log(`✓ context-hub 생성 및 clone 완료: ${hubLocalPath}`);
      } catch {
        console.log('  (레포 생성/clone 실패 — 수동으로 진행하세요)');
      }

      const hubConfig = {
        repos: [
          {
            channelName: 'context-hub',
            channelId: hubChannelId,
            fullName: `${hubUser}/context-hub`,
            localPath: hubLocalPath,
            category: 'personal',
            description: '개인/팀 컨텍스트 허브. 이메일, 캘린더, 메모 등 범용 작업의 기본 목적지.',
            isHub: true,
          },
        ],
        gmail: [] as { email: string; label: string }[],
      };
      fs.writeFileSync(configPath, JSON.stringify(hubConfig, null, 2) + '\n');
      console.log(`✓ simpleclaw.config.json 생성 완료 (context-hub isHub: true)`);

      console.log('\n  ── gogcli 인증 안내 ───────────────────────────────────────────');
      console.log('  context-hub의 gmail / google-calendar skill은 gogcli를 사용합니다.');
      console.log('  설치: brew install gogcli');
      console.log('  인증:');
      console.log('    1. https://console.cloud.google.com/auth/clients 에서 OAuth 클라이언트(Desktop app) 생성 후 JSON 다운로드');
      console.log('    2. gog auth credentials ~/Downloads/client_secret_....json');
      console.log('    3. gog auth add <your-email@gmail.com> --services gmail,calendar');
      console.log('  ──────────────────────────────────────────────────────────────\n');
    } else {
      console.error('\n[error] simpleclaw.config.json not found.');
      console.error('  Copy simpleclaw.config.example.json, fill in your repos and Gmail accounts, then re-run setup.\n');
      process.exit(1);
    }
  }

  // ── Prerequisite: simpleclaw.config.json ────────────────────────────────────────
  const clawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
    repos: { channelName: string }[];
    gmail: { email: string; label: string }[];
  };
  console.log(`\nFound ${clawConfig.repos.length} repo(s) and ${clawConfig.gmail.length} Gmail account(s) in simpleclaw.config.json.`);

  // ── Auth ──────────────────────────────────────────────────────────────────
  header('Auth');
  console.log('  Claude Max subscription required. Get token with: claude setup-token');
  const CLAUDE_CODE_OAUTH_TOKEN = await ask('Claude OAuth token');
  const GH_TOKEN = await ask('GitHub PAT (repo + workflow scopes)');

  // ── Discord ───────────────────────────────────────────────────────────────
  header('Discord');
  console.log('  봇 토큰만 입력하면 나머지는 자동으로 탐지합니다.');
  const DISCORD_BOT_TOKEN = await ask('Bot token');
  const DISCORD_PUBLIC_KEY = await ask('Public key (discord.com/developers → 앱 선택 → General Information)');
  const DISCORD_OWNER_USER_ID = await ask('Your Discord user ID (Discord 설정 → 고급 → 개발자 모드 ON 후 본인 프로필 우클릭 → ID 복사)');

  console.log('\n  Discord API로 서버와 채널을 자동 탐지 중...');
  let DISCORD_APPLICATION_ID: string;
  let DISCORD_GUILD_ID: string;
  let DISCORD_CHANNEL_GENERAL: string;
  try {
    const detected = await autoDetectDiscord(DISCORD_BOT_TOKEN);
    DISCORD_APPLICATION_ID = detected.applicationId;
    DISCORD_GUILD_ID = detected.guildId;
    DISCORD_CHANNEL_GENERAL = hubChannelId || detected.generalChannelId;
    if (hubChannelId) {
      console.log(`  → 일반 채널: context-hub 설정에서 가져옴 (${hubChannelId})`);
    }
  } catch (e) {
    console.error(`\n  [자동 탐지 실패] ${(e as Error).message}`);
    console.log('  수동으로 입력합니다.');
    DISCORD_APPLICATION_ID = await ask('Application ID');
    DISCORD_GUILD_ID = await ask('Guild (server) ID');
    DISCORD_CHANNEL_GENERAL = await ask('Channel ID — general', hubChannelId);
  }

  const DISCORD_CHANNEL_MAIL_ALERTS = await ask(
    'Channel ID — mail alerts (blank = same as general)',
    '',
  );
  console.log('\n  (SimpleClaw 전용 채널은 선택사항입니다. 지정하지 않으면 일반 채널에서 SimpleClaw 유지보수 요청을 처리합니다.)');
  const DISCORD_CHANNEL_SIMPLECLAW = await ask('Channel ID — SimpleClaw maintenance (선택, blank = 없음)', '');

  // ── Gmail ─────────────────────────────────────────────────────────────────
  header('Gmail');
  const GMAIL_CLIENT_ID = await ask('OAuth client ID (from Google Cloud Console)');
  const GMAIL_CLIENT_SECRET = await ask('OAuth client secret');

  const gmailTokenLines: string[] = [];
  if (clawConfig.gmail.length > 0) {
    console.log('\n  Generate each refresh token with: tsx scripts/gmail-auth.ts <email>');
    for (let i = 0; i < clawConfig.gmail.length; i++) {
      const account = clawConfig.gmail[i];
      const token = await ask(`Refresh token for ${account.email} (${account.label})`);
      gmailTokenLines.push(`GMAIL_REFRESH_TOKEN_${i + 1}=${token}`);
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  header('Dashboard');
  const DASHBOARD_PORT = await ask('Port', '3200');
  const DASHBOARD_SECRET = await ask('Secret (min 8 chars)');

  // ── Paths ─────────────────────────────────────────────────────────────────
  header('Paths');
  const DATA_DIR = await ask('Data directory', path.join(clawDir, 'data'));
  const LOGS_DIR = await ask('Logs directory', path.join(clawDir, 'logs'));

  // ── Write .env ────────────────────────────────────────────────────────────
  const envLines = [
    '# Generated by `pnpm run setup`',
    '',
    '# ── Auth ────────────────────────────────────────────────────────',
    `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}`,
    `GH_TOKEN=${GH_TOKEN}`,
    '',
    '# ── Discord ─────────────────────────────────────────────────────',
    `DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}`,
    `DISCORD_APPLICATION_ID=${DISCORD_APPLICATION_ID}`,
    `DISCORD_PUBLIC_KEY=${DISCORD_PUBLIC_KEY}`,
    `DISCORD_GUILD_ID=${DISCORD_GUILD_ID}`,
    `DISCORD_CHANNEL_GENERAL=${DISCORD_CHANNEL_GENERAL}`,
    ...(DISCORD_CHANNEL_SIMPLECLAW ? [`DISCORD_CHANNEL_SIMPLECLAW=${DISCORD_CHANNEL_SIMPLECLAW}`] : []),
    ...(DISCORD_CHANNEL_MAIL_ALERTS ? [`DISCORD_CHANNEL_MAIL_ALERTS=${DISCORD_CHANNEL_MAIL_ALERTS}`] : []),
    `DISCORD_OWNER_USER_ID=${DISCORD_OWNER_USER_ID}`,
    '',
    '# ── Gmail ────────────────────────────────────────────────────────',
    `GMAIL_CLIENT_ID=${GMAIL_CLIENT_ID}`,
    `GMAIL_CLIENT_SECRET=${GMAIL_CLIENT_SECRET}`,
    ...gmailTokenLines,
    '',
    '# ── Polling ──────────────────────────────────────────────────────',
    `MAIL_POLL_INTERVAL_SEC=300`,
    '',
    '# ── Dashboard ────────────────────────────────────────────────────',
    `DASHBOARD_PORT=${DASHBOARD_PORT}`,
    `DASHBOARD_SECRET=${DASHBOARD_SECRET}`,
    '',
    '# ── Paths ────────────────────────────────────────────────────────',
    `DATA_DIR=${DATA_DIR}`,
    `LOGS_DIR=${LOGS_DIR}`,
  ];

  const envPath = path.join(clawDir, '.env');
  fs.writeFileSync(envPath, envLines.join('\n') + '\n');
  console.log(`\n✓ .env written to ${envPath}`);

  // ── launchd plist (macOS only) ────────────────────────────────────────────
  if (process.platform !== 'darwin') {
    console.log('\nNon-macOS platform — skipping launchd plist generation.');
    console.log('Start SimpleClaw manually: pnpm build && pnpm start');
    rl.close();
    return;
  }

  header('macOS daemon (launchd)');
  const nodePath = process.execPath;
  const uid = execSync('id -u').toString().trim();
  const home = process.env['HOME'] ?? `/Users/${process.env['USER']}`;
  const plistLabel = 'com.simpleclaw';
  const plistDir = path.join(home, 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, `${plistLabel}.plist`);

  // Build PATH: node's bin dir + common tool dirs + homebrew if present
  const nodeBinDir = path.dirname(nodePath);
  const extraDirs = ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`]
    .filter((d) => fs.existsSync(d))
    .join(':');
  const daemonPath = [nodeBinDir, extraDirs, '/usr/bin:/bin'].filter(Boolean).join(':');

  fs.mkdirSync(path.join(clawDir, 'logs'), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${plistLabel}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${path.join(clawDir, 'dist', 'server.js')}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${clawDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${daemonPath}</string>
        <key>HOME</key>
        <string>${home}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(clawDir, 'logs', 'launchd.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(clawDir, 'logs', 'launchd.error.log')}</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  console.log(`✓ Plist written to ${plistPath}`);
  console.log(`  node: ${nodePath}`);
  console.log(`  PATH: ${daemonPath}`);

  const doBootstrap = await ask('\nBootstrap daemon now? (y/n)', 'y');
  if (doBootstrap.toLowerCase() === 'y') {
    try {
      execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: 'inherit' });
      console.log(`\n✓ Daemon registered. Next steps:`);
    } catch {
      console.log('\n  (Already loaded or bootstrap failed — continuing)');
    }
    console.log(`  1. pnpm run migrate`);
    console.log(`  2. pnpm build`);
    console.log(`  3. launchctl kickstart -k gui/${uid}/${plistLabel}`);
  } else {
    console.log(`\nTo start later:`);
    console.log(`  launchctl bootstrap gui/${uid} "${plistPath}"`);
    console.log(`  pnpm run migrate && pnpm build`);
    console.log(`  launchctl kickstart -k gui/${uid}/${plistLabel}`);
  }

  rl.close();
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});
