#!/usr/bin/env bash
# CCRouter status line -- shows session name in Claude Code footer
# Receives session JSON on stdin from Claude Code

set -euo pipefail

# Read stdin (CC session data) but we don't need it for the name lookup
cat > /dev/null

# Find our session by walking the process tree to match tty
MY_TTY=""
WALK_PID=$$
for i in 1 2 3 4 5 6; do
  WALK_PID=$(ps -o ppid= -p "$WALK_PID" 2>/dev/null | tr -d ' ' || echo "")
  if [ -z "$WALK_PID" ] || [ "$WALK_PID" = "1" ]; then
    break
  fi
  WALK_TTY=$(ps -o tty= -p "$WALK_PID" 2>/dev/null | tr -d ' ' || echo "")
  if [ -n "$WALK_TTY" ] && [ "$WALK_TTY" != "??" ]; then
    MY_TTY="$WALK_TTY"
    break
  fi
done

if [ -z "$MY_TTY" ]; then
  echo "CCRouter: ?"
  exit 0
fi

DB="$HOME/.ccrouter/ccrouter.db"
if [ ! -f "$DB" ]; then
  echo "CCRouter: no db"
  exit 0
fi

NAME=$(sqlite3 "$DB" "SELECT friendly_name FROM sessions WHERE tty='$MY_TTY' AND is_active=1 LIMIT 1;" 2>/dev/null || echo "")

if [ -n "$NAME" ]; then
  echo "$NAME"
else
  echo "CCRouter: unregistered"
fi
