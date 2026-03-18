#!/usr/bin/env bash
# CCRouter session-start hook
# Called by Claude Code on SessionStart event
# Reads session JSON from stdin, registers with daemon, outputs context

set -euo pipefail

DAEMON_URL="http://127.0.0.1:19919"

# Read session JSON from stdin
SESSION_JSON=$(cat)

# Extract session_id and cwd from the JSON (pid is not provided by CC)
SESSION_ID=$(echo "$SESSION_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")
CWD=$(echo "$SESSION_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")

# Determine PID and TTY by walking up the process tree from this hook script.
# The hook runs as: shell (tty) -> claude (tty) -> hook.sh (no tty)
# So we walk up to find the first ancestor with a tty.
TTY=""
PID=""
WALK_PID=$$
for i in 1 2 3 4 5; do
  WALK_PID=$(ps -o ppid= -p "$WALK_PID" 2>/dev/null | tr -d ' ' || echo "")
  if [ -z "$WALK_PID" ] || [ "$WALK_PID" = "1" ]; then
    break
  fi
  WALK_TTY=$(ps -o tty= -p "$WALK_PID" 2>/dev/null | tr -d ' ' || echo "")
  if [ -n "$WALK_TTY" ] && [ "$WALK_TTY" != "??" ]; then
    TTY="$WALK_TTY"
    PID="$WALK_PID"
    break
  fi
done

# Debug log
DEBUG_LOG="$HOME/.ccrouter/hook-debug.log"
echo "$(date): sid=$SESSION_ID pid=$PID tty=$TTY (walked from $$)" >> "$DEBUG_LOG"

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Look up previous session name for this workspace (for re-identification)
DESIRED_NAME=""
SESSIONS_DIR="$HOME/.ccrouter/last-sessions"
if [ -d "$SESSIONS_DIR" ] && [ -n "$CWD" ]; then
  CWD_HASH=$(echo -n "$CWD" | md5 2>/dev/null || echo -n "$CWD" | md5sum 2>/dev/null | cut -d' ' -f1)
  SESSION_FILE="$SESSIONS_DIR/${CWD_HASH}.json"
  if [ -f "$SESSION_FILE" ]; then
    DESIRED_NAME=$(python3 -c "
import json, sys
try:
    sessions = json.load(open('$SESSION_FILE'))
    if sessions and len(sessions) > 0:
        print(sessions[0].get('friendlyName', ''))
except: pass
" 2>/dev/null || echo "")
  fi
fi

# Build registration payload
PAYLOAD=$(python3 -c "
import json, sys
d = {'session_id': '$SESSION_ID'}
if '$CWD': d['cwd'] = '$CWD'
if '$PID': d['pid'] = int('$PID') if '$PID'.isdigit() else None
if '$TTY': d['tty'] = '$TTY'
if '$DESIRED_NAME': d['desired_name'] = '$DESIRED_NAME'
print(json.dumps(d))
" 2>/dev/null || echo '{"session_id":"'"$SESSION_ID"'"}')

# Register with daemon
RESPONSE=$(curl -s -X POST "$DAEMON_URL/register" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 2 \
  --max-time 5 2>/dev/null || echo "")

if [ -z "$RESPONSE" ]; then
  # Daemon not running -- session will need to use register_self tool
  echo "[CCRouter] Daemon not reachable. Use the register_self tool with session_id: $SESSION_ID"
  exit 0
fi

# Extract friendly name
FRIENDLY_NAME=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('friendly_name','unknown'))" 2>/dev/null || echo "unknown")

# Write session ID to env file if available
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export CCROUTER_SESSION_ID=$SESSION_ID" >> "$CLAUDE_ENV_FILE"
fi

# Output context for Claude to see
echo "[CCRouter] Session registered as \"$FRIENDLY_NAME\". You can use CCRouter tools (list_sessions, send_message, read_messages, etc.) to communicate with other Claude Code sessions."
