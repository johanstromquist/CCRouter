#!/usr/bin/env bash
# PreToolUse hook for CCRouter MCP tools.
# Injects the CC session_id into every CCRouter tool call so the MCP
# server knows which session it serves. Auto-binds on first use.
set -euo pipefail
INPUT=$(cat)
SID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
if [ -n "$SID" ]; then
  echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
ti['_session_id'] = sys.argv[1]
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'allow',
    'updatedInput': ti
  }
}))
" "$SID"
fi
exit 0
