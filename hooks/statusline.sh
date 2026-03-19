#!/usr/bin/env bash
# CCRouter status line -- shows session name in Claude Code footer
# Uses TTY to identify which session this terminal belongs to (unique per terminal).

set -euo pipefail

cat > /dev/null

TIMESTAMP=$(date +"%H:%M:%S")

# Find our TTY by walking the process tree
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

if [ -z "$MY_TTY" ]; then
  echo "CCRouter: ? | $TIMESTAMP"
  exit 0
fi

# Query DB with parameterized query (no SQL injection)
DB="$HOME/.ccrouter/ccrouter.db"
if [ ! -f "$DB" ]; then
  echo "CCRouter: ? | $TIMESTAMP"
  exit 0
fi

NAME=$(python3 -c "
import sqlite3, sys
try:
    db = sqlite3.connect(sys.argv[1])
    row = db.execute('SELECT friendly_name FROM sessions WHERE tty=? AND is_active=1 LIMIT 1', (sys.argv[2],)).fetchone()
    print(row[0] if row else '')
except: print('')
" "$DB" "$MY_TTY" 2>/dev/null || echo "")

if [ -n "$NAME" ]; then
  echo "$NAME | $TIMESTAMP"
else
  echo "CCRouter: ? | $TIMESTAMP"
fi
