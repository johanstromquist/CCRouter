#!/usr/bin/env bash
# CCRouter session-start hook
# Called by Claude Code on SessionStart event
# Reads session JSON from stdin, registers with daemon, outputs context

set -euo pipefail

# Read daemon URL from config (default: localhost)
DAEMON_URL="http://127.0.0.1:19919"
CONFIG_FILE="$HOME/.ccrouter/config.json"
if [ -f "$CONFIG_FILE" ]; then
  CONFIGURED_URL=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('daemonUrl',''))" "$CONFIG_FILE" 2>/dev/null || echo "")
  if [ -n "$CONFIGURED_URL" ]; then
    DAEMON_URL="$CONFIGURED_URL"
  fi
fi

# Read session JSON from stdin
SESSION_JSON=$(cat)

# Extract session_id and cwd from the JSON (pid is not provided by CC)
SESSION_ID=$(echo "$SESSION_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")
CWD=$(echo "$SESSION_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")

# The CC process PID is our direct parent (PPID).
# The MCP server is also a child of CC, so it shares the same PPID.
# This is used to link the MCP to its session in the daemon DB.
CC_PID="$PPID"

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# desired_name is intentionally NOT read from last-sessions here.
# In multi-terminal workspaces, all terminals share the same cwd hash,
# so reading sessions[0] would give every terminal the same name.
# Use 'claude-r' for named session recovery instead.
DESIRED_NAME=""

# Build registration payload (using sys.argv to prevent code injection)
PAYLOAD=$(python3 -c "
import json, sys
d = {'session_id': sys.argv[1]}
if sys.argv[2]: d['cwd'] = sys.argv[2]
if sys.argv[3]: d['pid'] = int(sys.argv[3]) if sys.argv[3].isdigit() else None
print(json.dumps(d))
" "$SESSION_ID" "$CWD" "$CC_PID" 2>/dev/null || echo "{\"session_id\":\"$SESSION_ID\"}")

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

# Output context for Claude to see
echo "[CCRouter] Session registered as \"$FRIENDLY_NAME\". You can use CCRouter tools (list_sessions, send_message, read_messages, etc.) to communicate with other Claude Code sessions."
