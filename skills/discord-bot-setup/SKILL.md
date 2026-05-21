---
name: discord-bot-setup
description: 새 Discord 봇 레포 설정 또는 별도 봇 구현 시 표준 체크리스트 주입
triggers:
  - 새 봇
  - 별도 봇
  - 별도 discord application
  - 새 discord bot
  - bot 레포 만들
  - discord bot 구현
  - discord bot 설정
---

# Discord 봇 설정 표준 체크리스트

## 구현 시작 전 필수 확인
- 어떤 Discord 봇(BOT_TOKEN / Discord Application)에 붙이는가?
- 현재 SimpleClaw bot과 다른 봇인 경우, 별도 레포 및 프로세스가 필요한지 확인
- 봇 토큰이 대화에 평문으로 공유된 경우, 즉시 재발급 안내 후 새 토큰 수신 전까지 대기

## 새 봇 레포 필수 포함 요소
1. **세션 영속화**: threadId → sessionId를 JSON 파일로 영속 저장 (재시작 후 기존 세션 resume 유지)
2. **재시작 마커 패턴**: `__BOTNAME_RESTART__` 감지 → `await postChunks()` 완료 후 `launchctl kickstart` 실행 (setTimeout 없이 순서 보장)
3. **launchd KeepAlive plist**: 프로세스 크래시 시 자동 재시작
4. **CLAUDE.md**: 마커 규칙 및 재시작 패턴 명시
5. **보안**: 토큰은 .env에만 보관, 대화 평문 공유 감지 시 즉시 재발급 안내

## 보안 인터럽트
대화에서 Discord 봇 토큰 패턴(MTQ로 시작하는 긴 문자열)이 감지되면 즉시:
> '토큰이 대화에 포함됐습니다. Discord Developer Portal에서 반드시 재발급 후 .env를 업데이트해주세요. 새 토큰을 공유해주시면 계속 진행하겠습니다.'