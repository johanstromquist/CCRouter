#!/usr/bin/env bash
# CCRouter installer
# Builds the project, wires up MCP config, hooks, and launchd plist

set -euo pipefail

CCROUTER_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
MCP_JSON="$CLAUDE_DIR/mcp.json"
SETTINGS_JSON="$CLAUDE_DIR/settings.json"
PLIST_NAME="com.ccrouter.daemon"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$PLIST_NAME.plist"

echo "=== CCRouter Installer ==="
echo "Project dir: $CCROUTER_DIR"
echo ""

# 1. Build
echo "[1/6] Building TypeScript..."
cd "$CCROUTER_DIR"
npm run build
echo "  Build complete."

# 2. Make hooks executable
echo "[2/6] Setting hook permissions..."
chmod +x "$CCROUTER_DIR/hooks/session-start.sh"
chmod +x "$CCROUTER_DIR/hooks/session-end.sh"
chmod +x "$CCROUTER_DIR/hooks/statusline.sh"
echo "  Done."

# 3. Wire MCP config via claude CLI
echo "[3/6] Configuring MCP server..."
# Remove existing ccrouter entry if present, then add fresh
claude mcp remove ccrouter 2>/dev/null || true
claude mcp add --transport stdio --scope user ccrouter -- node "$CCROUTER_DIR/dist/mcp-server.js"
echo "  Done."

# 4. Wire hooks into settings.json
echo "[4/6] Configuring hooks..."
if [ ! -f "$SETTINGS_JSON" ]; then
  echo '{}' > "$SETTINGS_JSON"
fi

python3 -c "
import json

with open('$SETTINGS_JSON', 'r') as f:
    settings = json.load(f)

if 'hooks' not in settings:
    settings['hooks'] = {}

settings['hooks']['SessionStart'] = [{
    'matcher': '*',
    'hooks': [{
        'type': 'command',
        'command': '$CCROUTER_DIR/hooks/session-start.sh'
    }]
}]

settings['hooks']['SessionEnd'] = [{
    'matcher': '*',
    'hooks': [{
        'type': 'command',
        'command': '$CCROUTER_DIR/hooks/session-end.sh'
    }]
}]

settings['statusLine'] = {
    'type': 'command',
    'command': '$CCROUTER_DIR/hooks/statusline.sh'
}

with open('$SETTINGS_JSON', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('  Added SessionStart and SessionEnd hooks + statusLine to settings.json')
"

# 5. Install statusline to app directory
echo "[5/6] Installing statusline..."
mkdir -p "$HOME/.ccrouter/app/hooks"
cp "$CCROUTER_DIR/hooks/statusline.sh" "$HOME/.ccrouter/app/hooks/statusline.sh"
chmod +x "$HOME/.ccrouter/app/hooks/statusline.sh"
echo "  Done."

# 6. Install launchd plist
echo "[6/6] Installing launchd daemon..."
mkdir -p "$CCROUTER_DIR/logs"
mkdir -p "$PLIST_DIR"

# Stop existing daemon if running
launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>$CCROUTER_DIR/dist/daemon.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$CCROUTER_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$CCROUTER_DIR/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$CCROUTER_DIR/logs/daemon.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

# Find the actual node path
NODE_PATH=$(which node)
if [ "$NODE_PATH" != "/usr/local/bin/node" ]; then
  # Update plist with correct node path
  sed -i '' "s|/usr/local/bin/node|$NODE_PATH|g" "$PLIST_PATH"
  echo "  Using node at: $NODE_PATH"
fi

launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "  Daemon installed and started."

echo ""
echo "=== Installation Complete ==="
echo ""
echo "The CCRouter daemon is running on http://127.0.0.1:19919"
echo "MCP server configured in ~/.claude.json"
echo "Hooks configured in $SETTINGS_JSON"
echo ""
echo "Verify with: curl http://127.0.0.1:19919/health"
echo ""
echo "To uninstall:"
echo "  launchctl bootout gui/$(id -u)/$PLIST_NAME"
echo "  claude mcp remove ccrouter"
echo "  Remove SessionStart/SessionEnd hooks from $SETTINGS_JSON"
