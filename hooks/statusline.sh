#!/usr/bin/env bash
# CCRouter status line -- shows session name in Claude Code footer
# Reads session_id from stdin JSON (provided by CC to all hooks and statusline)
# then queries the daemon HTTP API for the friendly name.
# Platform-agnostic: no TTY, no env vars, no shared files.

set -euo pipefail

# Read session JSON from stdin and extract session_id
SESSION_ID=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")

TIMESTAMP=$(date +"%H:%M:%S")

if [ -z "$SESSION_ID" ]; then
  echo "CCRouter: ? | $TIMESTAMP"
  exit 0
fi

# Read daemon URL from config (default: localhost)
DAEMON_URL="http://127.0.0.1:19919"
CONFIG_FILE="$HOME/.ccrouter/config.json"
if [ -f "$CONFIG_FILE" ]; then
  CONFIGURED_URL=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('daemonUrl',''))" "$CONFIG_FILE" 2>/dev/null || echo "")
  if [ -n "$CONFIGURED_URL" ]; then
    DAEMON_URL="$CONFIGURED_URL"
  fi
fi

NAME=$(curl -s --connect-timeout 1 --max-time 2 "$DAEMON_URL/session/$SESSION_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('friendly_name',''))" 2>/dev/null || echo "")

if [ -n "$NAME" ]; then
  echo "$NAME | $TIMESTAMP"
else
  echo "CCRouter: ? | $TIMESTAMP"
fi
