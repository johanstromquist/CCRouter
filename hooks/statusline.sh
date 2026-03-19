#!/usr/bin/env bash
# CCRouter status line -- shows session name in Claude Code footer
# Queries daemon HTTP API using session_id file (no direct DB access)

set -euo pipefail

# Read stdin (CC session data) but we don't need it for the name lookup
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

# Read session_id from file (consistent with PowerShell hook)
SESSION_ID=$(cat "$HOME/.ccrouter/session_id" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ]; then
  echo "CCRouter: ? | $TIMESTAMP"
  exit 0
fi

# Query daemon for session info
NAME=$(curl -s --connect-timeout 1 --max-time 2 "$DAEMON_URL/session/$SESSION_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('friendly_name',''))" 2>/dev/null || echo "")

if [ -n "$NAME" ]; then
  echo "$NAME | $TIMESTAMP"
else
  echo "CCRouter: unregistered | $TIMESTAMP"
fi
