# SimpleClaw

> Discord/Gmail을 인터페이스로, `claude` CLI를 두뇌로 — macOS에서 24/7 돌아가는 개인 AI 에이전트 게이트웨이.

메신저에 메시지를 보내면 SimpleClaw가 적절한 컨텍스트(스킬·메모리·레포)를 조립해 `claude --print`를 headless로 실행하고, 결과를 다시 채널로 돌려준다. 레포 코드 수정부터 이메일 초안까지 — 모두 채팅 하나로.

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
          │  ┌─────▼─────┐  │
          │  │  Skill    │  │  SKILL.md 자동 감지 + 주입
          │  │ Detector  │  │
          │  └─────┬─────┘  │
          │        │        │
          │  ┌─────▼─────┐  │
          │  │  Memory   │  │  3-layer hybrid 검색
          │  │  Loader   │  │
          │  └─────┬─────┘  │
          └────────┼────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
   (trivial)             (repo work)
   즉시 답변            spawn claude
                    --print --resume <id>
                    cwd = repo 디렉터리
                    systemAppend = 스킬+메모리
                         │
                         ▼
                  ┌─────────────┐
                  │   SQLite    │
                  │  sessions   │
                  │  memories   │
                  │   events    │
                  └──────┬──────┘
                         │
                         ▼
              Discord thread 응답 + 파일 첨부
```

### 핵심 루프

1. **분류** — Haiku가 메시지를 보고 `trivial` / `repo` / `unclear` 중 하나로 분류
2. **스킬 주입** — `simpleclaw/skills/` + 레포의 `.claude/skills/`에서 가장 관련된 SKILL.md를 찾아 `systemAppend`에 삽입
3. **메모리 주입** — 관련 메모리를 hybrid 검색(BM25 + 임베딩)으로 가져와 함께 주입
4. **Claude 실행** — `claude --print --resume <session_id>` headless 실행, 결과 수신
5. **응답 전송** — Discord thread에 포스팅 (2000자 자동 분할, 파일 첨부 지원)
6. **사후 분석** — 2시간마다 완료된 thread를 재분석해 스킬 제안·메모리 업데이트

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
  ]
}
```

`gmail[]`의 refresh token은 `.env`의 `GMAIL_REFRESH_TOKEN_1`, `_2`, … 와 순서대로 매핑됩니다.

### `.env`

비밀값(토큰·키·ID)만 보관합니다. `pnpm run setup`으로 자동 생성되며, `.env.example`을 참조하세요.

---

## 주요 기능

### 스킬 시스템

```
simpleclaw/skills/         ← 레포 무관 SimpleClaw 전역 스킬 (여기 추가)
  simpleclaw-debug/SKILL.md
  system-design-tdd/SKILL.md
  examples/               ← 템플릿 (비활성, 복사해서 커스터마이즈)
    b2b-email/SKILL.md
    calendar-scheduling/SKILL.md

{repo}/.claude/skills/    ← 레포 전용 스킬
  add-api-endpoint/SKILL.md
```

- SKILL.md의 `triggers` 키워드를 기반으로 Haiku가 자동 선택
- 선택된 스킬의 본문이 Claude 실행 전 `systemAppend`에 주입됨
- 세션 내 짧은 후속 메시지(<15자)는 직전 스킬 자동 재사용

### 3-Layer 메모리 시스템

| Layer | 저장소 | TTL | 설명 |
|-------|--------|-----|------|
| 1. Candidate | `memories_candidate` | 7일 | 단기 기억. `!기억` 단축어·자동 추출로 저장 |
| 2. Active | `memories` | 영구 | 점수 0~1000+. 참조·분석으로 승격 |
| 3. Embedding | `memories.embedding` | — | 온디바이스 HuggingFace 임베딩 |

- **스코프**: `global` / `repo:{name}` / `channel:{id}` 3단계
- **하이브리드 검색**: BM25 키워드 + 코사인 유사도 혼합 (60/20/20 가중치)
- **Decay**: 밤 시간 DreamingScheduler가 오래된 메모리 점수 감소

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

### Gmail 통합

- 복수 계정 주기 폴링 (기본 5분, `MAIL_POLL_INTERVAL_SEC`으로 조정)
- Claude가 중요도 판정 → 중요 메일만 `DISCORD_CHANNEL_MAIL_ALERTS` 채널에 thread 생성
- `ignore-sender` 버튼으로 발신자 정책 관리

---

## 스킬 추가

```bash
mkdir -p skills/my-skill
cat > skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: 한 줄 설명 (Haiku 분류기가 사용)
triggers:
  - 트리거 키워드 1
  - 트리거 키워드 2
---

# 주입될 내용
Claude에게 전달할 지침...
EOF

git add skills/my-skill/SKILL.md
git commit -m "feat: my-skill 추가"
git push
```

> `skills/examples/`에 있는 템플릿을 `skills/`로 복사한 뒤 커스터마이즈하는 것도 좋은 출발점입니다.

> **레포 전용 스킬**은 `{repo}/.claude/skills/` 하위에 같은 포맷으로 작성.

---

## 아키텍처 세부

### 데이터베이스 (SQLite)

| 테이블 | 용도 |
|--------|------|
| `sessions` | thread_id → claude session_id, 레포, 마지막 스킬 |
| `memories` | 활성 메모리 (스코프, 태그, 점수, 임베딩) |
| `memories_candidate` | 단기 후보 메모리 |
| `events` | 전체 이벤트 감사 로그 (FTS5 전문검색) |
| `skill_proposals` | 자동 감지된 스킬 제안 (pending/approved) |
| `message_queue` | 재시작 중 수신 메시지 버퍼 |
| `sender_policies` | Gmail 발신자 허용/차단 정책 |

### 대시보드

htmx 기반 SSR 대시보드 (`:3200`, `DASHBOARD_SECRET` 인증):
- 이벤트 뷰어 (FTS5 전문검색)
- 세션 히스토리
- 메모리 브라우저
- 스킬 제안 큐 (승인/거절)

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
| 분류기 | Claude Haiku (라우터, 스킬 감지, 중요도) |
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
    skill-detector.ts     SKILL.md 감지·선택·주입
    prompt.ts             systemAppend 빌더
  state/
    db.ts                 SQLite 초기화
    sessions.ts           thread ↔ session 매핑
    memories.ts           Layer 2 메모리 CRUD
    memories-hybrid.ts    BM25+임베딩 하이브리드 검색
    events.ts             감사 로그·FTS5 검색
  scheduler/
    repo-sync.ts          주기적 git pull
    dreaming.ts           밤 시간 메모리 decay
  dashboard/
    routes.ts             /dashboard 엔드포인트 (htmx)
skills/                   SimpleClaw 전역 스킬 (레포 무관)
  examples/               사용 예시 템플릿 (비활성)
scripts/
  setup.ts                대화형 설치 위저드
  gmail-auth.ts           Gmail OAuth refresh token 발급
data/                     SQLite DB (gitignored)
logs/                     pino 로그 (gitignored)
```
