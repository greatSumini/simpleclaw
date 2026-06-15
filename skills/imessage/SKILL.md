---
name: imessage
description: iMessage 수신 내역 확인 및 메시지 발송 — chat.db sqlite3 조회 + osascript 발송
triggers:
  - iMessage
  - 아이메시지
  - imessage 확인
  - imessage 보내
  - 문자 확인
  - 메시지 보내
  - 메시지 확인
  - 연락 왔어
  - 답장 보내
---

# iMessage 확인 및 발송 가이드

## 사전 조건 (권한 없으면 동작 안 함)

- **읽기**: 시스템 환경설정 > 개인 정보 보호 > **전체 디스크 접근** — node / Terminal 허용
- **발송**: 시스템 환경설정 > 개인 정보 보호 > **자동화** — Terminal → Messages 허용

---

## 1. 최근 수신 메시지 조회

```bash
sqlite3 -header -column ~/Library/Messages/chat.db "
SELECT
  m.rowid,
  datetime(m.date/1000000000 + 978307200, 'unixepoch', '+9 hours') AS received_kst,
  h.id         AS sender,
  COALESCE(c.display_name, '') AS chat_name,
  m.text
FROM message m
LEFT JOIN handle h         ON h.rowid = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
LEFT JOIN chat c           ON c.rowid = cmj.chat_id
WHERE m.is_from_me = 0
  AND m.date > 0
  AND m.text IS NOT NULL
ORDER BY m.rowid DESC
LIMIT 20;
"
```

## 2. 특정 발신자(전화번호/이메일)와의 최근 대화 조회

```bash
SENDER="+821012345678"  # 또는 "user@example.com"
sqlite3 -header -column ~/Library/Messages/chat.db "
SELECT
  m.rowid,
  datetime(m.date/1000000000 + 978307200, 'unixepoch', '+9 hours') AS ts_kst,
  CASE m.is_from_me WHEN 1 THEN '(나)' ELSE h.id END AS sender,
  m.text
FROM message m
LEFT JOIN handle h         ON h.rowid = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
LEFT JOIN chat c           ON c.rowid = cmj.chat_id
WHERE (h.id = '$SENDER' OR c.chat_identifier = '$SENDER')
  AND m.text IS NOT NULL
ORDER BY m.rowid DESC
LIMIT 30;
"
```

## 3. iMessage 발송 (osascript)

```bash
osascript -e 'tell application "Messages"
  set targetBuddy to buddy "+821012345678" of service "iMessage"
  send "메시지 내용" to targetBuddy
end tell'
```

이메일 iMessage 발송:
```bash
osascript -e 'tell application "Messages"
  set targetBuddy to buddy "user@example.com" of service "iMessage"
  send "메시지 내용" to targetBuddy
end tell'
```

## 4. 발송 전 필수 확인 단계

1. 조회로 대화 맥락 먼저 확인
2. 초안을 사용자에게 제시
3. **사용자 명시적 승인 후에만 발송** (`ㄱㄱ` / `발송해` 등)
4. 발송 완료 후 결과 보고

## 5. 주의사항

- 첨부파일(이미지·파일)은 osascript로 발송 불가 (텍스트만 가능)
- 그룹 채팅 발송은 chat_id로 접근해야 함 — 단순 buddy 지정 아님
- 발신자가 phone number인지 email인지 주의 (`+82` 형식 또는 `user@icloud.com`)
- 메시지 DB는 읽기 전용 접근만 허용 (수정·삭제 불가)
