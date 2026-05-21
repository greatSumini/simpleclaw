---
name: simpleclaw-debug
description: SimpleClaw 시스템 버그 진단, 레이스컨디션, 재시작 이슈, 메시지 큐 문제 분석
triggers:
  - simpleclaw 버그
  - 재시작
  - 레이스
  - 큐
  - 세션
  - 메시지 누락
  - 중복 실행
  - 권한 없는 실행
  - launchctl
---

# SimpleClaw 디버깅 지침

## 아키텍처 핵심 컨텍스트
- **SimpleClaw** = Discord 봇 + 오케스트레이터. `launchctl`로 관리되는 macOS 서비스.
- **재시작 흐름**: Claude 응답에 `__SIMPLECLAW_RESTART__` 마커 → SimpleClaw가 제거 후 `launchctl kickstart` 실행
- **메시지 큐**: 재시작 대기 중 수신 메시지는 SQLite `message_queue`에 보관 → 재시작 완료 후 자동 처리
- **세션 추적**: SQLite `sessions` 테이블. `thread_id` → `claude_session_id` 매핑.
- **뮤텍스**: thread별 `runWithMutex()` — 동일 thread 동시 실행 방지

## 자주 발생하는 버그 패턴

### 권한 없는 실행 (Unauthorized action)
- 원인: 라우팅 classifier가 사용자 확인 없이 repo-work로 분류
- 확인: `events` 테이블 `type='claude.invoke'` 로그 → 직전 router 결정 확인
- 수정: `router.ts`의 classifier 프롬프트 강화 또는 화이트리스트 조건 추가

### 재시작 루프
- 원인: 마커가 있는데 `launchctl`이 이미 재시작 중
- 확인: `launchd.log` + `pendingRestart` 상태 확인
- 수정: `pendingRestart` 플래그 → 루프 내 체크로 조기 종료

### 메시지 누락
- 원인: 재시작 타이밍에 수신된 메시지가 큐에 안 들어감
- 확인: `message_queue` 테이블 조회
- 수정: 재시작 드레인 시작 시점 vs 큐 등록 시점 레이스 확인

## 디버깅 절차
1. `sqlite3 data/simpleclaw.db "SELECT * FROM events ORDER BY ts DESC LIMIT 20;"` — 최근 이벤트 확인
2. `tail -100 logs/simpleclaw.log` — 최근 로그
3. 재현 가능하면 `__tests__/` 아래 단위 테스트 추가
4. 수정 후 `pnpm build` → 재시작 마커 출력

## 소스 변경 시 필수
- 빌드: `pnpm build`
- 재시작: 응답 마지막 줄에 `__SIMPLECLAW_RESTART__` 마커 (앞에 사람이 읽을 텍스트 필수)
