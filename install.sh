#!/usr/bin/env bash
# CCRouter installer
# Builds the project, wires up MCP config, hooks, launchd plists, extension, and data files

set -euo pipefail

CCROUTER_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
MCP_JSON="$CLAUDE_DIR/mcp.json"
SETTINGS_JSON="$CLAUDE_DIR/settings.json"
PLIST_DIR="$HOME/Library/LaunchAgents"
DAEMON_PLIST_NAME="com.ccrouter.daemon"
SSE_PLIST_NAME="com.ccrouter.mcp-sse"
APP_DIR="$HOME/.ccrouter/app"

echo "=== CCRouter Installer ==="
echo "Project dir: $CCROUTER_DIR"
echo ""

# 1. Build
echo "[1/10] Building TypeScript..."
cd "$CCROUTER_DIR"
npm run build
echo "  Build complete."

# 2. Make hooks executable
echo "[2/10] Setting hook permissions..."
chmod +x "$CCROUTER_DIR/hooks/session-start.sh"
chmod +x "$CCROUTER_DIR/hooks/session-end.sh"
chmod +x "$CCROUTER_DIR/hooks/statusline.sh"
chmod +x "$CCROUTER_DIR/hooks/ack-message.sh"
echo "  Done."

# 3. Wire MCP config via claude CLI
echo "[3/10] Configuring MCP server..."
claude mcp remove ccrouter 2>/dev/null || true
claude mcp add --transport stdio --scope user ccrouter -- node "$CCROUTER_DIR/dist/mcp-server.js"
echo "  Done."

# 4. Wire hooks into settings.json
echo "[4/10] Configuring hooks..."
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

settings['hooks']['UserPromptSubmit'] = [{
    'hooks': [{
        'type': 'command',
        'command': '$CCROUTER_DIR/hooks/ack-message.sh',
        'async': True
    }]
}]

settings['statusLine'] = {
    'type': 'command',
    'command': '$CCROUTER_DIR/hooks/statusline.sh'
}

with open('$SETTINGS_JSON', 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('  Added SessionStart, SessionEnd, UserPromptSubmit hooks + statusLine to settings.json')
"

# 5. Create directories and install files to app directory
echo "[5/10] Setting up app directory..."
mkdir -p "$APP_DIR/dist"
mkdir -p "$APP_DIR/hooks"
mkdir -p "$HOME/.ccrouter/data"
mkdir -p "$HOME/.ccrouter/bridges"
mkdir -p "$HOME/.ccrouter/last-sessions"
mkdir -p "$HOME/.ccrouter/logs"

# Copy dist files
cp "$CCROUTER_DIR"/dist/*.js "$APP_DIR/dist/"
cp "$CCROUTER_DIR"/dist/*.js "$APP_DIR/"

# Copy data files (name generator)
cp "$CCROUTER_DIR"/data/*.json "$HOME/.ccrouter/data/"

# Copy hooks
cp "$CCROUTER_DIR/hooks/statusline.sh" "$APP_DIR/hooks/statusline.sh"
cp "$CCROUTER_DIR/hooks/ack-message.sh" "$APP_DIR/hooks/ack-message.sh"
chmod +x "$APP_DIR/hooks/statusline.sh"
chmod +x "$APP_DIR/hooks/ack-message.sh"

# Copy node_modules for SSE server (needs @modelcontextprotocol/sdk)
if [ -d "$CCROUTER_DIR/node_modules" ]; then
  rsync -a --delete "$CCROUTER_DIR/node_modules/" "$APP_DIR/node_modules/" 2>/dev/null || \
    cp -r "$CCROUTER_DIR/node_modules" "$APP_DIR/"
fi
echo "  Done."

# 6. Install launchd daemon plist
echo "[6/10] Installing launchd daemon..."
mkdir -p "$PLIST_DIR"

# Stop existing daemon if running
launchctl bootout "gui/$(id -u)/$DAEMON_PLIST_NAME" 2>/dev/null || true

NODE_PATH=$(which node)

cat > "$PLIST_DIR/$DAEMON_PLIST_NAME.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$DAEMON_PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$APP_DIR/dist/daemon.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.ccrouter/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.ccrouter/logs/daemon.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PATH</key>
        <string>$(dirname "$NODE_PATH"):/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$PLIST_DIR/$DAEMON_PLIST_NAME.plist"
echo "  Daemon installed and started."

# 7. Install launchd SSE MCP plist (for remote CC connections)
echo "[7/10] Installing SSE MCP server..."

launchctl bootout "gui/$(id -u)/$SSE_PLIST_NAME" 2>/dev/null || true

cat > "$PLIST_DIR/$SSE_PLIST_NAME.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SSE_PLIST_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$APP_DIR/dist/mcp-server.js</string>
        <string>--sse</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/ccrouter-mcp-sse.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ccrouter-mcp-sse.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$HOME</string>
        <key>PATH</key>
        <string>$(dirname "$NODE_PATH"):/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$(id -u)" "$PLIST_DIR/$SSE_PLIST_NAME.plist"
echo "  SSE MCP server installed and started."

# 8. Build and install Cursor extension
echo "[8/10] Building Cursor extension..."
cd "$CCROUTER_DIR/cursor-extension"
npx @vscode/vsce package --allow-missing-repository 2>/dev/null
VSIX_PATH="$CCROUTER_DIR/cursor-extension/ccrouter-terminal-bridge-1.0.0.vsix"
cp "$VSIX_PATH" "$HOME/.ccrouter/"

if command -v cursor &>/dev/null; then
  cursor --install-extension "$VSIX_PATH" 2>/dev/null && \
    echo "  Extension installed in Cursor." || \
    echo "  Extension built but Cursor CLI install failed. Install manually from: $VSIX_PATH"
else
  echo "  Extension built. Cursor CLI not found -- install manually from: $VSIX_PATH"
fi

# 9. Install claude-r
echo "[9/10] Installing claude-r..."
chmod +x "$CCROUTER_DIR/bin/claude-r"
mkdir -p "$HOME/bin"
ln -sf "$CCROUTER_DIR/bin/claude-r" "$HOME/bin/claude-r"
echo "  Installed to ~/bin/claude-r"

# 10. Verify
echo "[10/10] Verifying..."
cd "$CCROUTER_DIR"
sleep 2

DAEMON_HEALTH=$(curl -s http://127.0.0.1:19919/health 2>/dev/null || echo "FAILED")
SSE_HEALTH=$(curl -s http://127.0.0.1:19920/health 2>/dev/null || echo "FAILED")

echo "  Daemon: $DAEMON_HEALTH"
echo "  SSE MCP: $SSE_HEALTH"

# Get LAN IP
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "unknown")

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Local services:"
echo "  Daemon:  http://0.0.0.0:19919 (network-accessible)"
echo "  SSE MCP: http://0.0.0.0:19920 (for remote CC sessions)"
echo ""
echo "Remote machine setup (one-time):"
echo "  claude mcp add ccrouter --transport sse --url http://${LAN_IP}:19920/sse"
echo "  Then tell CC: 'Run CCRouter install'"
echo ""
echo "Crash recovery:"
echo "  claude-r           -- resume last session for current workspace"
echo "  claude-r --list    -- show saved sessions"
echo "  claude-r --pick    -- choose from multiple sessions"
echo ""
echo "Verify: curl http://127.0.0.1:19919/health"
echo ""
echo "To uninstall:"
echo "  launchctl bootout gui/$(id -u)/$DAEMON_PLIST_NAME"
echo "  launchctl bootout gui/$(id -u)/$SSE_PLIST_NAME"
echo "  claude mcp remove ccrouter"
echo "  Remove hooks from $SETTINGS_JSON"
