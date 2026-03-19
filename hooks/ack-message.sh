#!/usr/bin/env bash
# CCRouter auto-ack hook -- acknowledges received CCRouter messages.
# Runs on UserPromptSubmit. Detects [#channel] sender: ... pattern
# and sends an ack to the daemon so the sender knows delivery succeeded.
# Reads session_id from stdin JSON (platform-agnostic).

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

# Read the hook JSON from stdin -- contains both prompt and session_id
INPUT=$(cat)

# Extract prompt and session_id
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prompt',''))" 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")

# Match CCRouter message pattern: [#channel] sender: message
if [[ "$PROMPT" =~ ^\[(\#[a-zA-Z0-9_-]+)\]\ ([a-zA-Z0-9_-]+):\ .+ ]]; then
  CHANNEL="${BASH_REMATCH[1]}"
  SENDER="${BASH_REMATCH[2]}"

  if [ -n "$SESSION_ID" ]; then
    curl -s -X POST "$DAEMON_URL/ack" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$CHANNEL\",\"sender\":\"$SENDER\",\"session_id\":\"$SESSION_ID\"}" \
      --connect-timeout 1 --max-time 2 > /dev/null 2>&1 || true
  fi
fi
