# SimpleClaw 설치 지침

> 이 문서는 Claude Code가 직접 읽고 실행하는 설치 지침입니다.
> SimpleClaw 레포를 아직 clone하지 않은 상태에서 시작해도 됩니다.
> 아래 순서를 그대로 따라 진행하세요.

---

## 0. 준비물 확인

아래 항목을 순서대로 확인하고, 없으면 설치 안내 후 사용자 확인을 받는다.

```bash
node --version      # 22 이상이어야 함
pnpm --version
claude --version    # @anthropic-ai/claude-code
gh --version        # GitHub CLI
```

- Node.js < 22: [nodejs.org](https://nodejs.org) 설치 안내
- pnpm 없음: `npm i -g pnpm`
- Claude CLI 없음: `npm i -g @anthropic-ai/claude-code`
- gh CLI 없음: [cli.github.com](https://cli.github.com) 설치 안내
- Claude Max 구독 여부는 사용자에게 확인

---

## 1. Discord 준비

사용자에게 아래 내용을 **한 번에** 물어본다 (AskUserQuestion으로 묶기):

> **Discord 준비가 필요합니다. 아직 안 하셨다면 아래 단계를 따라주세요.**
>
> **봇 생성** (이미 있으면 건너뜀)
> 1. [discord.com/developers/applications](https://discord.com/developers/applications) → New Application
> 2. Bot 탭 → Add Bot → Reset Token으로 봇 토큰 복사
> 3. Privileged Gateway Intents → **MESSAGE CONTENT INTENT** 켜기
> 4. OAuth2 → URL Generator → `bot` 스코프 + `Send Messages / Read Message History / Manage Messages / View Channels` 권한 → 생성된 URL로 서버에 초대
>
> 준비가 되셨으면 아래 정보를 알려주세요:
> - **봇 토큰**
> - **Public Key** (앱 페이지 → General Information)
> - **본인 Discord User ID** (Discord 설정 → 고급 → 개발자 모드 ON → 본인 프로필 우클릭 → ID 복사)
>
> 나머지(Application ID, 서버 ID, 채널 ID)는 봇 토큰으로 자동 탐지합니다.

위 정보를 모두 받은 뒤 다음 단계로 진행한다.

---

## 2. 클론 & 의존성 설치

clone 위치를 사용자에게 묻는다 (기본값 제안: `~/simpleclaw`).

```bash
git clone https://github.com/greatSumini/simpleclaw.git <클론경로>
cd <클론경로>
pnpm install
```

이후 모든 명령은 이 디렉터리 안에서 실행한다.

---

## 3. 설치 위저드 실행

```bash
pnpm run setup
```

위저드가 순서대로 질문한다. 각 항목 입력 방법:

| 질문 | 입력값 |
|------|--------|
| Context Hub 생성 여부 | `y` — GitHub에 context-hub 레포 자동 생성 + clone |
| GitHub 사용자명 | 사용자 GitHub 계정명 |
| 로컬 경로 | 기본값 그대로 Enter (또는 원하는 경로) |
| 일반 채널 ID | 1단계에서 받은 일반 채널 ID |
| Claude OAuth token | `claude setup-token` 실행 후 나오는 토큰 |
| GitHub PAT | repo + workflow 스코프 PAT ([github.com/settings/tokens](https://github.com/settings/tokens)) |
| Bot token | 1단계에서 받은 봇 토큰 |
| Public key | 1단계에서 받은 Public Key |
| Your Discord user ID | 1단계에서 받은 본인 User ID |
| (자동 탐지) Application ID, 서버 ID, 일반 채널 ID | 봇 토큰으로 자동 감지 — 확인만 |
| Channel ID — mail alerts | Enter (비워둠 — 기본값: 일반 채널) |
| Channel ID — SimpleClaw maintenance | Enter (비워둠 — 선택사항) |
| Gmail client ID / secret | Enter (비워둠 — 이메일은 context-hub skill로 처리) |
| Dashboard port | 기본값 `3200` |
| Dashboard secret | 8자 이상 임의 문자열 |
| Bootstrap daemon now? | `y` |

---

## 4. DB 초기화 & 빌드

```bash
pnpm run migrate
pnpm build
```

---

## 5. 데몬 시작

setup에서 Bootstrap을 완료했으면:

```bash
launchctl kickstart -k gui/$(id -u)/com.simpleclaw
```

상태 확인:
```bash
launchctl list | grep com.simpleclaw
```

---

## 6. (선택) Gmail·캘린더 연동

context-hub에 gmail/google-calendar skill이 내장되어 있습니다.
사용하려면 gogcli를 인증합니다.

```bash
brew install gogcli
# Google Cloud Console에서 OAuth 클라이언트(Desktop app) JSON 다운로드 후:
gog auth credentials ~/Downloads/client_secret_....json
gog auth add <your-email@gmail.com> --services gmail,calendar
```

인증 완료 후 Discord 일반 채널에서 "지난주 이메일 요약해줘" 로 바로 사용 가능합니다.

---

## 설치 완료 안내

설치가 끝나면 사용자에게 다음을 알려준다:

- **일반 채널**: 이메일, 캘린더, 메모, 질문 — 무엇이든 여기서
- **SimpleClaw 채널**: SimpleClaw 자체 코드 수정 및 디버그 요청
- **레포 채널** (선택): 특정 GitHub 레포 연결 후 해당 코드 작업 전용

로그 확인: `tail -f logs/launchd.log` (SimpleClaw 클론 디렉터리 안에서)

---

## 문제 해결

아래 명령은 SimpleClaw를 clone한 디렉터리 안에서 실행한다.

```bash
# 재시작
pnpm build && launchctl kickstart -k gui/$(id -u)/com.simpleclaw

# 로그
tail -f logs/launchd.log logs/launchd.error.log
```
