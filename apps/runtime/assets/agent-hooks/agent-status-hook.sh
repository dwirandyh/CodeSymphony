#!/bin/sh
# CodeSymphony terminal agent-status hook.
#
# A terminal-hosted agent CLI (Claude Code / Codex / OpenCode) runs this on each
# lifecycle transition. It POSTs the raw event to the runtime, which normalizes
# it into a status badge on the terminal tab. Best-effort: always exits 0 and
# never blocks the CLI.
#
# Session identity + endpoint come from the env the runtime injects at spawn:
#   CS_TERMINAL_SESSION_ID  which terminal this CLI lives in
#   CS_AGENT_HOOK_URL       runtime endpoint to POST to
#   CS_AGENT_ID             claude | codex | opencode (default: claude)

[ -n "$CS_TERMINAL_SESSION_ID" ] || exit 0
[ -n "$CS_AGENT_HOOK_URL" ] || exit 0

# Codex passes JSON as argv; Claude/OpenCode pipe JSON via stdin.
if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT="$(cat)"
fi

# Claude/OpenCode use "hook_event_name"; Codex's native notify uses "type".
EVENT_TYPE="$(printf '%s' "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [ -z "$EVENT_TYPE" ]; then
  EVENT_TYPE="$(printf '%s' "$INPUT" | sed -n 's/.*"type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
fi
[ -n "$EVENT_TYPE" ] || exit 0

TOOL_NAME="$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
AGENT="${CS_AGENT_ID:-claude}"

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

PAYLOAD="{\"sessionId\":\"$(json_escape "$CS_TERMINAL_SESSION_ID")\",\"eventType\":\"$(json_escape "$EVENT_TYPE")\""
if [ -n "$TOOL_NAME" ]; then
  PAYLOAD="$PAYLOAD,\"toolName\":\"$(json_escape "$TOOL_NAME")\""
fi
PAYLOAD="$PAYLOAD,\"agent\":\"$(json_escape "$AGENT")\"}"

curl -sX POST "$CS_AGENT_HOOK_URL" \
  --connect-timeout 2 --max-time 5 \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  -o /dev/null 2>/dev/null || true

exit 0
