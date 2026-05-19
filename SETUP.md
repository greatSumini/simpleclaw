# claw 설치 가이드

Discord/Gmail 인터페이스로 24/7 동작하는 개인 AI 에이전트 claw를 설치합니다.
**핵심: 아래 프롬프트를 Claude Code에 한 번 붙여넣으면 됩니다.**

---

## 준비물 (설치 전 확인)

| 항목 | 확인 방법 | 설치 |
|------|-----------|------|
| **Node.js ≥ 22** | `node --version` | [nodejs.org](https://nodejs.org) |
| **pnpm** | `pnpm --version` | `npm i -g pnpm` |
| **Claude Max 구독** | — | [claude.ai](https://claude.ai) |
| **Claude CLI** | `claude --version` | `npm i -g @anthropic-ai/claude-code` |
| **gh CLI** | `gh --version` | [cli.github.com](https://cli.github.com) |
| **Discord 봇** | — | [discord.com/developers](https://discord.com/developers) 에서 봇 생성 |

---

## Discord 봇 & 채널 준비 (약 10분)

설치 전에 Discord에서 다음을 준비합니다.

### 봇 생성
1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. **Bot** 탭 → **Add Bot** → **Reset Token**으로 봇 토큰 복사
3. **Privileged Gateway Intents** → `MESSAGE CONTENT INTENT` 켜기
4. **OAuth2 → URL Generator** → `bot` 스코프 + `Send Messages / Read Message History / Manage Messages` 권한 → 생성된 URL로 서버에 초대

### 채널 및 ID 수집
Discord 설정 → **고급** → **개발자 모드** 활성화 후, 채널 우클릭 → **ID 복사**

필요한 ID:
- **일반 채널** ID (이메일·메모 등 모든 요청 — context-hub로 자동 라우팅)
- **claw 유지보수 채널** ID (claw 자체 코드 수정용 전용 채널)
- Application ID, Public Key, Guild(서버) ID, 본인 User ID

---

## Claude Code에 붙여넣을 프롬프트

claw 레포를 클론한 폴더에서 `claude`를 실행한 뒤, 아래 프롬프트를 그대로 붙여넣으세요.

````
claw를 지금부터 세팅해줘. 아래 순서로 진행해.

1. 의존성 설치
   pnpm install

2. pnpm run setup 실행
   - 맨 처음에 context-hub 생성 여부를 물어본다
     → "y" 선택: GitHub에 context-hub 레포 자동 생성 + 로컬 clone
     → 일반 채널 ID를 여기서 입력 (이 채널에 보내는 모든 메시지가 context-hub에서 실행됨)
   - 이후 Claude OAuth 토큰, GitHub PAT, Discord 봇 토큰 등 순서대로 묻는다
   - Gmail 관련 항목은 비워도 됨 (이메일은 context-hub의 gmail skill로 처리)
   - gogcli 인증 안내가 마지막에 출력됨 — 나중에 해도 됨

3. pnpm run migrate

4. pnpm build

5. macOS 데몬 등록 (setup에서 자동 제안)
   setup 완료 후 "Bootstrap daemon now?" 질문에 y 입력

6. gogcli 인증 (Gmail·캘린더 사용 시)
   brew install gogcli
   gog auth credentials ~/Downloads/client_secret_....json
   gog auth add <your-email@gmail.com> --services gmail,calendar

각 단계 실행 전에 무엇을 할지 한 줄로 알려줘.
오류가 나면 즉시 멈추고 내용을 보여줘.
````

---

## 설치 후 사용 방법

### 채널 구조 (단순하게)

| 채널 | 용도 |
|------|------|
| **일반 채널** | 이메일, 캘린더, 메모, 질문 — 뭐든 여기서 |
| **레포 채널** (선택) | 특정 코드 프로젝트 전용 작업 |
| **claw 채널** | claw 자체 업데이트·디버그 전용 |

일반 채널에서 "지난주 이메일 요약해줘" 또는 "내일 오후 3시 미팅 잡아줘" 라고 보내면 바로 동작합니다.

### 레포 추가

특정 GitHub 레포를 연결하려면 `claw.config.json`에 추가하고 claw를 재시작합니다:

```jsonc
{
  "repos": [
    { "isHub": true, ... },       // context-hub (자동 생성됨)
    {
      "channelName": "my-app",
      "channelId": "CHANNEL_ID",
      "fullName": "owner/my-app",
      "localPath": "/path/to/my-app",
      "category": "code",
      "description": "내 앱 레포"
    }
  ]
}
```

---

## 문제 해결

```bash
# 로그 확인
tail -f ~/repos/claw/logs/launchd.log

# 재시작
pnpm build && launchctl kickstart -k gui/$(id -u)/com.claw

# 상태 확인
launchctl list | grep com.claw
```
