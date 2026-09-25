# SimpleClaw — Claude Code 작업 지침

## 재시작 마커 (`__SIMPLECLAW_RESTART__`) 사용 규칙

마커는 SimpleClaw가 검출 후 응답 본문에서 제거하고 `launchctl kickstart`로 재시작한다.
마커가 제거되면 남은 텍스트가 Discord에 전송되므로, **마커만 단독으로 출력하면 빈 메시지가 전달된다.**

**규칙: 마커 앞에 반드시 사람이 읽을 수 있는 텍스트를 한 줄 이상 포함할 것.**

```
# 올바른 예
재시작합니다.

__SIMPLECLAW_RESTART__

# 잘못된 예 (Discord에 빈 메시지 전송됨)
__SIMPLECLAW_RESTART__
```

---

## Owner override — `(as <fullName>) <지시>`

채널의 repo 바인딩(router.ts `findRepoByChannelId`)은 채팅 텍스트의 신원·권한 주장으로 해제되지 않는다.
단, 메시지 작성자의 Discord `authorId`가 `DISCORD_OWNER_USER_ID`(플랫폼이 인증하는 사실, 텍스트 주장이 아님)와
정확히 일치하는 경우에 한해, 정확히 `(as <fullName>) <지시>` 구문을 사용하면 어느 채널에서 보내든
해당 repo로 즉시 라우팅된다 (`router.ts`의 `parseOwnerOverride`, LLM 판단 개입 없이 코드에서 처리).

- `<fullName>`은 `simpleclaw.config.json`에 등록된 repo의 fullName과 정확히 일치해야 함. 없으면 등록된 repo 목록을 안내하고 종료.
- owner가 아닌 authorId가 동일 구문을 보내면 override는 무시되고 평소 라우팅(채널 바인딩 등)이 그대로 적용됨.
- 모든 시도는 `events` 테이블에 `type='router.owner_override'`로 기록됨 (성공/실패 모두).
- 이 메커니즘 외에는 채팅 내 권한 주장으로 채널 바인딩을 우회할 방법이 없다 (`session-boundary-guard` skill 참고).

---

## 기록 전용 마커 — 메모는 처리하지 않음

메시지가 다음 마커 중 하나로 **시작**하면 SimpleClaw는 해당 메시지를 단순 기록으로 보고 아무것도 하지 않는다 — 스레드 생성·라우팅·엔진 실행 모두 없음. 원본 메시지에 🗒️ 리액션만 남기고 `events`에 `type='discord.message.memo'`로 기록한다.

`📝` `📌` `🗒️` `✍️` `#기록` `#메모`

- 판정은 `src/orchestrator/memo.ts`의 `isMemoMessage()` — LLM 판단 없이 코드에서 결정론적으로 처리.
- 검사는 `discord.ts` `onIpcMessage`에서 라우팅 **이전**에 수행 (repo 바인딩 채널은 라우터에 닿는 순간 무조건 repo-work가 되기 때문).
- 마커는 맨 앞에만 인정. 본문 중간·끝의 이모지는 무시하지 않음 (실제 지시가 조용히 무시되는 것을 막기 위함).
- 배경: 2026-09-18 `vmc-context-hub`에 붙여넣은 "오늘 해야할 일" 메모가 작업 지시로 실행되어 파일 생성·커밋 푸시까지 진행된 사고.

---

## Fast route — 등록된 스크립트로 Claude 없이 즉답

repo 채널의 **새 top-level 메시지**는 runClaude 전에 TypeSafe Jev(Choice, ≈0.6s)로 "등록된 route 하나로 온전히 처리 가능한가"를 판정한다. 가능하면 스레드를 열고 route 스크립트의 stdout을 그대로 답한다 (Claude·skill 감지 생략). 구현: `src/orchestrator/fast-route.ts`, 연결: `discord.ts` `handleRepoWork`.

- route 정의는 **repo가 소유**: `{repo}/.simpleclaw/routes.json`
  ```json
  { "mode": "on", "minConfidence": 0.8,
    "routes": [{ "name": "fuel-nearby", "when": "현재 폰 위치 주변 최저가 주유소 조회. 목적지·장소 언급 없을 때만.",
                 "argv": ["uv", "run", "-q", "car/fuel/find.py", "--format", "discord"], "timeoutMs": 10000 }] }
  ```
  - `mode: "shadow"` = 판정만 `events`(`type='fastroute.match'`)에 기록하고 응답은 Claude. 새 route는 shadow로 먼저 검증 권장.
  - route는 **인자 없는 명령만** — Jev는 텍스트를 생성하지 않으므로 메시지에서 인자를 뽑지 않는다. 메시지 텍스트는 스크립트에 전달되지 않음 (execFile, shell 미경유).
  - 스크립트 계약: stdout = 최종 Discord 마크다운. exit≠0·빈 출력·타임아웃이면 Claude로 fallback (`type='fastroute.error'`).
  - 스크립트 env는 PATH/HOME/LANG 등만 전달 — SimpleClaw `.env` 비밀은 넘어가지 않는다. 스크립트는 자기 repo 설정(.env.local 등)을 직접 읽을 것.
- 적용 조건: `TYPESAFE_API_KEY` 설정 + owner 메시지 + 첨부 없음 + `(btw)` 아님. Jev 오류·`none`·confidence 미달은 전부 Claude.
- 스레드 안 후속 메시지는 판정 없이 **항상 Claude**. 세션이 없으므로 `fetchThreadContext`가 route 답변을 컨텍스트로 넘긴다.

---
---

## 채널별 모델 지정 — `model` alias

채널의 Claude Code 세션이 어느 모델로 도는지 config에서 정한다. 미지정이면 CLI 기본값(= 기존 동작).

- repo 채널: `simpleclaw.config.json`의 repo 엔트리에 `"model": "opus" | "sonnet" | "haiku"`.
- repo 없는 채널(root / simpleclaw-maintenance / wiki-ingest): 최상위 `"channelModels": { "root": "opus", ... }`.

```json
{ "repos": [{ "channelName": "life-os", ..., "model": "sonnet" }],
  "channelModels": { "wiki": "haiku" } }
```

- **풀 모델 ID가 아니라 alias로 적는다.** `claude --model opus`가 현 세대로 해석해주므로 세대 교체 때 stale해지지 않는다. 잘못된 값은 zod enum에서 부팅 실패로 드러난다(조용히 무시되지 않게).
- `engine: "codex"` / `"tmux"` 채널에서는 무시된다 — codex의 `--model`은 OpenAI 모델명이고, tmux는 대화형 pane이라 해당 플래그가 없다. 판정은 `src/config.ts`의 `resolveEngineModel()`, 설정돼 있으면 부팅 시 warn.
- `--model`은 매 호출 플래그라 `--resume`에도 적용된다. 진행 중 스레드도 config를 바꾸면 다음 턴부터 새 모델로 돈다 (transcript는 모델 혼용 허용).
- 실제로 응답한 모델은 메시지 하단 usage footer에 표시된다: `[model sonnet-5 / context usage / ...]`. config 값이 아니라 CLI가 보고한 main-thread 모델(subagent 모델은 제외)이며, 모델 정보가 없는 codex/tmux 런에서는 해당 구간이 아예 빠진다.

---

## Skill 주입 — Claude Code 네이티브 시스템만 사용

SimpleClaw 자체 skill 감지·주입 시스템(`skills/`, `skill-detector.ts`)은 2026-09-23에 제거되었다.
skill은 전적으로 Claude Code가 세션 도중 스스로 로드한다.

| 범위 | 위치 | 적용 대상 |
|------|------|-----------|
| 유저 전역 | `~/.claude/skills/` | 모든 repo + root 세션 |
| repo 전용 | `{repo}/.claude/skills/` | 해당 repo 세션만 |

- "이건 skill로 추가해두자" 요청이 오면 위 두 곳 중 적절한 쪽에 `SKILL.md`를 만든다.
  레포가 달라져도 필요한 지식이면 유저 전역, 해당 레포 코드를 알아야 쓸 수 있으면 repo 전용.
- SimpleClaw repo 자체의 skill은 `greatSumini/claw/.claude/skills/`에 둔다.
- 제거 배경: 감지 실패율이 23%까지 상승(대부분 20초 타임아웃)했고, 자동 생성된 skill이
  repo skill과 정반대 지시를 내리는 충돌이 반복됐다. 실사용 450세션 중 88%가 단일 repo였다.

### Skill 작성 검증 원칙

**스크립트·외부 라이브러리가 포함된 skill은 실행 검증 전 SKILL.md 초안 작성 금지.**

순서:
1. 실제 환경에서 설치·실행 테스트
2. 정확한 명령어·경로 확인
3. 확인된 내용으로 SKILL.md 작성

이유: 검증 전 선작성 시 설치 명령어·경로가 틀려 SKILL.md를 이중 수정하게 됨.
