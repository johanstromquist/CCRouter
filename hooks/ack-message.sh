#!/usr/bin/env bash
# CCRouter auto-ack hook -- acknowledges received CCRouter messages.
# Runs on UserPromptSubmit. Detects [#channel] sender: ... pattern
# and sends an ack to the daemon so the sender knows delivery succeeded.

set -euo pipefail

# Read the hook JSON from stdin
INPUT=$(cat)

# Extract the user's prompt text from the hook input
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

  # Find our tty by walking the process tree
  MY_TTY=""
  WALK_PID=$$
  for i in 1 2 3 4 5 6; do
    WALK_PID=$(ps -o ppid= -p "$WALK_PID" 2>/dev/null | tr -d ' ' || echo "")
    if [ -z "$WALK_PID" ] || [ "$WALK_PID" = "1" ]; then break; fi
    WALK_TTY=$(ps -o tty= -p "$WALK_PID" 2>/dev/null | tr -d ' ' || echo "")
    if [ -n "$WALK_TTY" ] && [ "$WALK_TTY" != "??" ]; then
      MY_TTY="$WALK_TTY"
      break
    fi
  done

  if [ -n "$MY_TTY" ]; then
    # Fire-and-forget ack to daemon
    curl -s -X POST "http://127.0.0.1:19919/ack" \
      -H "Content-Type: application/json" \
      -d "{\"channel\":\"$CHANNEL\",\"sender\":\"$SENDER\",\"tty\":\"$MY_TTY\"}" \
      --connect-timeout 1 --max-time 2 > /dev/null 2>&1 || true
  fi
fi
