#!/bin/bash
# claw 프로세스와 독립적으로 도는 워치독.
# claw.error.log에 새로 쌓인 error/fatal(level>=50) pino 로그를 감지하면
# Discord 봇 토큰으로 REST API를 직접 호출해 DISCORD_CHANNEL_CLAW에 알린다.
# (claw 자신이 크래시 루프 중이라 스스로 알릴 수 없는 상황을 커버하기 위함 —
#  이 스크립트는 node/claw 코드에 의존하지 않는다.)
set -euo pipefail

ROOT="/Users/sumin/repos/greatSumini/claw"
ERR_LOG="$ROOT/logs/claw.error.log"
STATE_DIR="$ROOT/data"
OFFSET_FILE="$STATE_DIR/watchdog.offset"
LAST_ALERT_FILE="$STATE_DIR/watchdog.last_alert"
ALERT_COOLDOWN_SEC=300

mkdir -p "$STATE_DIR"
[ -f "$ERR_LOG" ] || exit 0

# .env에서 필요한 값만 로드 (export 없이 grep으로, 다른 값 오염 방지)
BOT_TOKEN=$(grep -m1 '^DISCORD_BOT_TOKEN=' "$ROOT/.env" | cut -d'=' -f2-)
CHANNEL_ID=$(grep -m1 '^DISCORD_CHANNEL_CLAW=' "$ROOT/.env" | cut -d'=' -f2-)
[ -n "$BOT_TOKEN" ] && [ -n "$CHANNEL_ID" ] || exit 0

CUR_SIZE=$(wc -c < "$ERR_LOG" | tr -d ' ')
PREV_OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)

# 로그 로테이션/축소된 경우 처음부터
if [ "$CUR_SIZE" -lt "$PREV_OFFSET" ]; then
  PREV_OFFSET=0
fi

NEW_BYTES=$((CUR_SIZE - PREV_OFFSET))
echo "$CUR_SIZE" > "$OFFSET_FILE"

if [ "$NEW_BYTES" -le 0 ]; then
  exit 0
fi

NEW_LINES=$(tail -c "+$((PREV_OFFSET + 1))" "$ERR_LOG")
FATAL_LINES=$(echo "$NEW_LINES" | jq -c 'select(.level >= 50)' 2>/dev/null || true)
[ -n "$FATAL_LINES" ] || exit 0

# 재알림 쿨다운 (크래시 루프 시 10초마다 알림 폭탄 방지)
NOW=$(date +%s)
LAST_ALERT=$(cat "$LAST_ALERT_FILE" 2>/dev/null || echo 0)
if [ $((NOW - LAST_ALERT)) -lt "$ALERT_COOLDOWN_SEC" ]; then
  exit 0
fi
echo "$NOW" > "$LAST_ALERT_FILE"

COUNT=$(echo "$FATAL_LINES" | wc -l | tr -d ' ')
FIRST_MSG=$(echo "$FATAL_LINES" | head -1 | jq -r '.msg // .err.message // "unknown error"')
KST_TIME=$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S KST')

CONTENT=$(cat <<EOF
🚨 **claw 크래시 감지** ($KST_TIME)
최근 ${ALERT_COOLDOWN_SEC}초 내 error/fatal 로그 ${COUNT}건
> ${FIRST_MSG}
launchd가 계속 재시작을 시도 중일 수 있음. \`tail -f logs/claw.error.log\` 로 확인 필요.
EOF
)

PAYLOAD=$(jq -n --arg content "$CONTENT" '{content: $content}')

curl -sS -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
  -H "Authorization: Bot ${BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null
