#!/usr/bin/env bash
# CCRouter auto-ack hook -- acknowledges received CCRouter messages.
# Runs on UserPromptSubmit. Detects [#channel] sender: ... pattern
# and sends an ack to the daemon so the sender knows delivery succeeded.

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

# Read the hook JSON from stdin
INPUT=$(cat)

# Extract the user's prompt text
PROMPT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('prompt', ''))
except:
    pass
" 2>/dev/null || echo "")

# Match CCRouter message pattern: [#channel] sender: message
if [[ "$PROMPT" =~ ^\[(\#[a-zA-Z0-9_-]+)\]\ ([a-zA-Z0-9_-]+):\ .+ ]]; then
  CHANNEL="${BASH_REMATCH[1]}"
  SENDER="${BASH_REMATCH[2]}"

  # Session ID from env var (per-session, set via CLAUDE_ENV_FILE)
  SESSION_ID="${CCROUTER_SESSION_ID:-}"
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(cat "$HOME/.ccrouter/session_id" 2>/dev/null || echo "")
  fi

  if [ -n "$SESSION_ID" ]; then
    curl -s -X POST "$DAEMON_URL/ack" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$CHANNEL\",\"sender\":\"$SENDER\",\"session_id\":\"$SESSION_ID\"}" \
      --connect-timeout 1 --max-time 2 > /dev/null 2>&1 || true
  fi
fi
