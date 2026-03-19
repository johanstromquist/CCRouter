#!/usr/bin/env bash
# CCRouter status line -- shows session name in Claude Code footer
# Uses CCROUTER_SESSION_ID env var (set by session-start hook via CLAUDE_ENV_FILE)

set -euo pipefail

cat > /dev/null

# Read daemon URL from config (default: localhost)
DAEMON_URL="http://127.0.0.1:19919"
CONFIG_FILE="$HOME/.ccrouter/config.json"
if [ -f "$CONFIG_FILE" ]; then
  CONFIGURED_URL=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('daemonUrl',''))" "$CONFIG_FILE" 2>/dev/null || echo "")
  if [ -n "$CONFIGURED_URL" ]; then
    DAEMON_URL="$CONFIGURED_URL"
  fi
fi

TIMESTAMP=$(date +"%H:%M:%S")

# Session ID from env var (per-session, set via CLAUDE_ENV_FILE by session-start hook)
SESSION_ID="${CCROUTER_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
  # Fallback: read from file (Windows, or if env var not propagated)
  SESSION_ID=$(cat "$HOME/.ccrouter/session_id" 2>/dev/null || echo "")
fi

if [ -z "$SESSION_ID" ]; then
  echo "CCRouter: ? | $TIMESTAMP"
  exit 0
fi

NAME=$(curl -s --connect-timeout 1 --max-time 2 "$DAEMON_URL/session/$SESSION_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('friendly_name',''))" 2>/dev/null || echo "")

if [ -n "$NAME" ]; then
  echo "$NAME | $TIMESTAMP"
else
  echo "CCRouter: ? | $TIMESTAMP"
fi
