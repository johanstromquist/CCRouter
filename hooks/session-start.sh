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
# Normalize path separators so cwd hashes match across platforms
CWD="${CWD//\\//}"

# The CC process PID is our direct parent (PPID).
# Used for PID liveness checking during stale session cleanup.
CC_PID="$PPID"

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

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

# Bind the MCP server to this session. The MCP server runs on SSE and doesn't
# know which CC session it serves. The /bind endpoint matches the most recently
# connected unbound MCP transport to this session_id.
MCP_URL=$(echo "$DAEMON_URL" | sed 's/:19919/:19920/')
curl -s -X POST "$MCP_URL/bind" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SESSION_ID\"}" \
  --connect-timeout 1 --max-time 2 > /dev/null 2>&1 || true

echo "[CCRouter] Session registered as \"$FRIENDLY_NAME\". You can use CCRouter tools to communicate with other Claude Code sessions."
