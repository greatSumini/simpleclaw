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

## Skills 시스템

### 개요

SimpleClaw는 자체 skill 감지·주입 시스템을 갖는다. 유저 메시지가 들어오면 Haiku가 적합한 skill을 감지하고, 해당 skill의 내용을 메인 LLM 호출 시 systemAppend에 자동 주입한다.

### 디렉토리 구조

```
simpleclaw/
└── skills/
    └── {skill-name}/
        └── SKILL.md      # 필수. frontmatter에 name, description, triggers 포함
```

### SKILL.md 포맷

```markdown
---
name: skill-name
description: 한 줄 설명 (Haiku 분류기가 skill 선택 시 사용)
scope: internal | shared   # 생략 시 shared
triggers:
  - 트리거 키워드/패턴 예시 1
  - 트리거 키워드/패턴 예시 2
---

# (skill 본문 — 메인 LLM systemAppend에 주입되는 실제 내용)
```

**`scope` 필드 (신뢰 경계):**
- `shared` (기본값): 모든 세션(외부 repo-work 스레드 포함)에서 감지 후보로 사용 가능.
- `internal`: SimpleClaw 자체 유지보수 세션(`runSimpleClawMaintenanceInThread`)에서만 감지 후보로 사용됨. 외부 repo 채널의 `detectSkill()` 호출(`allowInternal` 미지정)에서는 후보에서 제외되어, Haiku 분류기 프롬프트에도 노출되지 않는다.
- SimpleClaw 내부 아키텍처/버그 패턴/DB 스키마 등 외부 repo 세션에 노출되면 안 되는 지식(예: `simpleclaw-debug`)은 반드시 `scope: internal`로 작성할 것.

### SimpleClaw skill vs Repo skill 구분 원칙

| 기준 | SimpleClaw skill | Repo (Claude Code) skill |
|------|-----------|--------------------------|
| 저장 위치 | `simpleclaw/skills/` | `{repo}/.claude/skills/` |
| 주입 주체 | SimpleClaw 오케스트레이터 (세션 시작 전) | Claude Code 에이전트 (세션 도중) |
| 대상 | 인터랙션 패턴 / 커뮤니케이션 방식 | 코드베이스 내 구현 패턴 |
| 핵심 질문 | "레포가 달라져도 이 지식이 필요한가?" | "이 레포 코드를 알아야 쓸 수 있는가?" |

**SimpleClaw skill에 속하는 것:**
- 커뮤니케이션 (B2B 이메일 초안, 캘린더 미팅 협의)
- SimpleClaw 시스템 자체 지식 (디버그, 재시작 패턴, 아키텍처)
- 레포에 무관하게 반복되는 크로스커팅 인터랙션 패턴

**Repo skill에 속하는 것:**
- 레포 내 코드 생성/수정 패턴 (API 추가, DB 쿼리 등)
- 레포 전용 CLI/스크립트 사용법
- 해당 레포 코드베이스 지식 없이는 쓸 수 없는 것

**중복 시:** repo skill로 단일화. SimpleClaw skill은 repo skill 호출을 유도하는 힌트만 제공.

### "이건 SimpleClaw skill로 추가해두자" 명령 처리

유저가 위 표현으로 명령하면:
1. `skills/{적절한-이름}/SKILL.md` 파일 생성
2. frontmatter에 name, description, triggers 작성
3. 본문에 주입할 실제 지침 내용 작성
4. git commit & push (소스 변경 아니므로 `pnpm build` 불필요, 재시작 마커 불필요)

### Skill 작성 검증 원칙

**스크립트·외부 라이브러리가 포함된 skill은 실행 검증 전 SKILL.md 초안 작성 금지.**

순서:
1. 실제 환경에서 설치·실행 테스트
2. 정확한 명령어·경로 확인
3. 확인된 내용으로 SKILL.md 작성

이유: 검증 전 선작성 시 설치 명령어·경로가 틀려 SKILL.md를 이중 수정하게 됨.
