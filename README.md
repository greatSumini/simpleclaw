<p align="center">
  <img src="docs/assets/avatar.png" alt="SimpleClaw" width="160" />
</p>

<h1 align="center">SimpleClaw</h1>

> Discord/Gmail을 인터페이스로, `claude` CLI를 두뇌로 — macOS에서 24/7 돌아가는 개인 AI 에이전트 게이트웨이.

메신저에 메시지를 보내면 SimpleClaw가 적절한 컨텍스트(레포·규칙)를 조립해 `claude --print`를 headless로 실행하고, 결과를 다시 채널로 돌려준다. 레포 코드 수정부터 이메일 초안까지 — 모두 채팅 하나로.

---

## 빠른 설치 (Claude Code 프롬프트)

`claude`를 실행한 뒤, 아래 프롬프트를 그대로 붙여넣으면 됩니다.

```
SimpleClaw를 내 macOS에 설치하고 설정해줘.
SimpleClaw GitHub: https://github.com/greatSumini/simpleclaw
Setup Guide 문서: https://github.com/greatSumini/simpleclaw/blob/main/SETUP.md
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js ≥ 22** | `node --version` |
| **pnpm** | `npm i -g pnpm` |
| **Claude Max subscription** | Required for `claude` CLI and OAuth token |
| **Claude CLI** | `npm i -g @anthropic-ai/claude-code` |
| **Discord bot** | Create at [discord.com/developers](https://discord.com/developers) — needs `MESSAGE_CONTENT` intent |
| **Gmail OAuth client** | Create at [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — Gmail API enabled |
| **GitHub PAT** | `repo` + `workflow` scopes |
| macOS | Daemon uses `launchd`. Linux/Windows: run manually with `pnpm start`. |

---

## 작동 원리

```
┌────────────────┐   ┌─────────────────┐
│   Discord      │   │   Gmail (×N)    │
│  (gateway)     │   │  (polling)      │
└───────┬────────┘   └────────┬────────┘
        │                     │
        └──────────┬──────────┘
                   │
          ┌────────▼────────┐
          │   Orchestrator  │
          │  ┌───────────┐  │
          │  │  Router   │  │  Haiku가 메시지 분류
          │  │ (classify)│  │  trivial / repo / unclear
          │  └─────┬─────┘  │
          │        │        │
          └────────┼────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
   (trivial)             (repo work)
   즉시 답변            spawn claude
                    --print --resume <id>
                    cwd = repo 디렉터리
                    --append-system-prompt = 지침·규칙
                         │
                         ▼
                  ┌─────────────┐
                  │   SQLite    │
                  │  sessions   │
                  │   events    │
                  └──────┬──────┘
                         │
                         ▼
              Discord thread 응답 + 파일 첨부
```

### 핵심 루프

1. **분류** — Haiku가 메시지를 보고 `trivial` / `repo` / `unclear` 중 하나로 분류
2. **Claude 실행** — `claude --print --resume <session_id>` headless 실행, 결과 수신
3. **응답 전송** — Discord thread에 포스팅 (2000자 자동 분할, 파일 첨부 지원)

주입되는 지침·규칙은 `--append-system-prompt`로 전달된다. 유저 턴에 인라인하면 세션 트랜스크립트에 남아 `--resume`마다 다시 과금되기 때문이다.

---

## 셋업

```bash
# 1. 클론 & 의존성
git clone https://github.com/greatSumini/simpleclaw.git && cd simpleclaw
pnpm install

# 2. 레포·Gmail 설정
cp simpleclaw.config.example.json simpleclaw.config.json
# simpleclaw.config.json 편집: 레포 목록, Gmail 계정 추가

# 3. 대화형 설치 위저드 (.env 생성 + launchd plist 자동 생성)
pnpm run setup

# 4. Gmail 인증 (계정별 1회, setup 전에 완료 권장)
tsx scripts/gmail-auth.ts you@example.com

# 5. DB 초기화 & 빌드
pnpm run migrate
pnpm build

# 6. 실행
node dist/server.js          # 단발 실행
# 또는
pnpm dev                     # 개발 모드 (tsx watch)
```

### macOS 데몬 등록

`pnpm run setup`이 자동으로 plist를 생성하고 bootstrap을 제안합니다. 수동으로 하려면:

```bash
# 등록 (로그인 시 자동 시작)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.simpleclaw.plist

# 상태 확인
launchctl list | grep com.simpleclaw

# 소스 수정 후 재시작
pnpm build && launchctl kickstart -k gui/$(id -u)/com.simpleclaw

# 로그
tail -f logs/launchd.log logs/launchd.error.log
```

---

## 설정 파일

### `simpleclaw.config.json` (gitignored)

레포 레지스트리와 Gmail 계정을 정의합니다. 소스코드를 수정하지 않고 설정만으로 레포를 추가/제거합니다.

```jsonc
{
  "repos": [
    {
      "channelName": "my-project",       // Discord 채널명
      "channelId": "DISCORD_CHANNEL_ID", // Discord 채널 snowflake ID
      "fullName": "owner/repo",          // GitHub 레포 전체명
      "localPath": "/absolute/path/to/repo",
      "category": "personal | code",
      "description": "라우팅 프롬프트에 사용되는 짧은 설명"
    }
  ],
  "gmail": [
    { "email": "you@example.com", "label": "personal" }
  ],
  "githubScopes": ["your-github-username", "your-org"], // 새 프로젝트 버튼의 scope 선택지 (최대 25, 생략 시 repos의 owner 목록)
  "projectChannelCategoryId": "CATEGORY_ID"            // 선택 — 새 채널을 만들 카테고리 (생략 시 일반 채널과 같은 카테고리)
}
```

`gmail[]`의 refresh token은 `.env`의 `GMAIL_REFRESH_TOKEN_1`, `_2`, … 와 순서대로 매핑됩니다.

### `.env`

비밀값(토큰·키·ID)만 보관합니다. `pnpm run setup`으로 자동 생성되며, `.env.example`을 참조하세요.

---

## 주요 기능

### 스킬 시스템

SimpleClaw는 자체 스킬 감지·주입을 하지 않는다. 스킬은 Claude Code가 세션 도중 직접 로드한다.

```
~/.claude/skills/          ← 유저 전역 (모든 레포 + root 세션)
  notion/SKILL.md

{repo}/.claude/skills/     ← 레포 전용
  add-api-endpoint/SKILL.md
```

### 세션 연속성

- Discord thread ↔ Claude `session_id` 매핑 (SQLite)
- 같은 thread의 후속 메시지는 `--resume`으로 동일 세션 재진입
- 스레드별 mutex로 동시 실행 방지

### 자동 재시작

Claude가 소스를 수정한 뒤 응답에 `__SIMPLECLAW_RESTART__` 마커를 포함하면:

1. SimpleClaw가 마커를 제거하고 Discord에 나머지 텍스트 전송
2. `pnpm build` (자동)
3. `launchctl kickstart -k gui/<uid>/com.simpleclaw`
4. 재시작 중 수신된 메시지는 queue에 저장 후 재생

### 새 프로젝트 버튼

`DISCORD_CHANNEL_SIMPLECLAW` 채널에 **🆕 새 프로젝트** 버튼이 자동으로 게시됩니다 (owner 전용).

1. 버튼 → 폼: GitHub scope(`githubScopes`) / repo 이름 / 공개 여부 / 이슈·PR 감시 / 설명
2. 계획 카드 확인 → **✅ 진행**
3. GitHub repo 생성(`gh repo create --add-readme`) → `$REPOS_DIR/{scope}/{이름}`에 clone → 같은 이름의 Discord 채널 생성 → `simpleclaw.config.json`에 등록

- 재시작 없이 바로 반영됩니다(gateway·worker 설정을 런타임에 갱신).
- 모든 단계는 멱등적입니다. 이미 있는 repo·clone·채널은 재사용하므로 기존 repo 연결에도 쓸 수 있고, 실패 후 **다시 시도**하면 이어서 진행합니다. 실패해도 아무것도 삭제하지 않습니다.
- 봇에 **채널 관리** 권한이 있어야 채널을 만들 수 있습니다.

### Gmail 통합

- 복수 계정 주기 폴링 (기본 5분, `MAIL_POLL_INTERVAL_SEC`으로 조정)
- Claude가 중요도 판정 → 중요 메일만 `DISCORD_CHANNEL_MAIL_ALERTS` 채널에 thread 생성
- `ignore-sender` 버튼으로 발신자 정책 관리

---

## 스킬 추가

Claude Code 네이티브 스킬로 추가한다. 레포가 달라져도 필요하면 유저 전역, 해당 레포
코드를 알아야 쓸 수 있으면 레포 전용에 둔다.

```bash
# 유저 전역 (모든 세션에서 로드)
mkdir -p ~/.claude/skills/my-skill
cat > ~/.claude/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: 한 줄 설명 — Claude Code가 이걸 보고 로드 여부를 판단한다
---

# 내용
Claude에게 전달할 지침...
EOF
```

> **레포 전용 스킬**은 `{repo}/.claude/skills/` 하위에 같은 포맷으로 작성 후 커밋.

---

## 아키텍처 세부

### 데이터베이스 (SQLite)

| 테이블 | 용도 |
|--------|------|
| `sessions` | thread_id → claude session_id, 레포, cwd |
| `events` | 전체 이벤트 감사 로그 (FTS5 전문검색) |
| `message_queue` | 재시작 중 수신 메시지 버퍼 |
| `sender_policies` | Gmail 발신자 허용/차단 정책 |

### 대시보드

htmx 기반 SSR 대시보드 (`:3200`, `DASHBOARD_SECRET` 인증):
- 이벤트 뷰어 (FTS5 전문검색)
- 세션 히스토리

---

## 기술 스택

| 레이어 | 선택 |
|--------|------|
| 런타임 | Node.js ≥ 22 (TypeScript) |
| 상태 저장 | SQLite (better-sqlite3, WAL 모드) |
| Discord | discord.js v14 |
| Gmail | googleapis v144 (OAuth 2.0) |
| 임베딩 | @huggingface/transformers (온디바이스) |
| LLM 오케스트레이션 | Claude CLI headless (`claude --print`) |
| 분류기 | Claude Haiku (라우터, 중요도) |
| 대시보드 | Express + htmx |
| 데몬 | macOS launchd (`KeepAlive: true`) |

---

## 디렉터리 구조

```
simpleclaw.config.json    레포·Gmail 설정 (gitignored, simpleclaw.config.example.json 복사)
.env                      비밀값 (gitignored, pnpm run setup으로 생성)
src/
  server.ts               Express + 데몬 entry
  config.ts               env + simpleclaw.config.json 파싱
  claude.ts               `claude --print` spawn wrapper
  adapters/
    discord.ts            Gateway 리스너, thread 관리, 재시작 핸들러
    gmail.ts              계정 폴링, 중요도 판정 위임
  orchestrator/
    router.ts             trivial/repo/unclear 분류기
    prompt.ts             systemAppend 빌더
  state/
    db.ts                 SQLite 초기화
    sessions.ts           thread ↔ session 매핑
    events.ts             감사 로그·FTS5 검색
  scheduler/
    repo-sync.ts          주기적 git pull
  dashboard/
    routes.ts             /dashboard 엔드포인트 (htmx)
scripts/
  setup.ts                대화형 설치 위저드
  gmail-auth.ts           Gmail OAuth refresh token 발급
data/                     SQLite DB (gitignored)
logs/                     pino 로그 (gitignored)
```
