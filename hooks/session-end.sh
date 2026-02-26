#!/usr/bin/env bash
# CCRouter session-end hook
# Called by Claude Code on SessionEnd event

set -euo pipefail

DAEMON_URL="http://127.0.0.1:19919"

# Read session JSON from stdin
SESSION_JSON=$(cat)

SESSION_ID=$(echo "$SESSION_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Deregister with daemon (best-effort)
curl -s -X POST "$DAEMON_URL/deregister" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$SESSION_ID\"}" \
  --connect-timeout 2 \
  --max-time 5 2>/dev/null || true
