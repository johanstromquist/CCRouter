# CCRouter

Cross-session communication for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Lets multiple Claude Code sessions discover each other, exchange messages, and read each other's transcripts.

## What it does

When you run multiple Claude Code sessions (e.g. one per project), CCRouter gives each session a friendly name (like `bold-bat` or `gentle-magpie`) and lets them talk to each other. This enables multi-agent workflows where sessions can coordinate, delegate tasks, and share results.

### Components

- **Daemon** -- HTTP server on `127.0.0.1:19919` that maintains a session registry and cleans up stale sessions
- **MCP server** -- Provides tools to Claude Code for listing sessions, sending messages, reading messages, and more
- **Hooks** -- SessionStart/SessionEnd hooks that auto-register and deregister sessions with the daemon
- **Terminal bridge extension** -- VS Code/Cursor extension that delivers messages directly into terminal sessions via `sendSequence`

### MCP tools

| Tool | Description |
|------|-------------|
| `list_sessions` | List all active Claude Code sessions |
| `send_message` | Send a message to a session by name, or `"*"` to broadcast |
| `read_messages` | Read messages sent to this session |
| `who_am_i` | Show this session's identity |
| `set_session_name` | Change this session's friendly name |
| `get_session_info` | Get details about a specific session |
| `read_session_transcript` | Read another session's conversation history |
| `register_self` | Manual registration fallback |

## Requirements

- macOS (uses `launchd` for the daemon, `ps` for process tree walking)
- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [VS Code](https://code.visualstudio.com/) or [Cursor](https://cursor.com/) (the terminal bridge extension uses VS Code's `sendSequence` API to deliver messages)

## Installation

```bash
git clone https://github.com/johanstromquist/CCRouter.git
cd CCRouter
npm install
./install.sh
```

The installer will:

1. Build the TypeScript source
2. Register the MCP server with Claude Code (`claude mcp add`)
3. Configure SessionStart/SessionEnd hooks in `~/.claude/settings.json`
4. Install and start the daemon via `launchd`

### Verify

```bash
curl http://127.0.0.1:19919/health
```

### Terminal bridge extension (required for message delivery)

The VS Code/Cursor extension is what actually delivers messages into terminal sessions. Without it, `send_message` stores messages in SQLite but the recipient has no way to see them unless they manually call `read_messages`. The extension pushes messages directly into the target session's terminal via VS Code's `sendSequence` API.

```bash
cd cursor-extension
npx @vscode/vsce package --allow-missing-repository

# For Cursor:
cursor --install-extension ccrouter-terminal-bridge-1.0.0.vsix

# For VS Code:
code --install-extension ccrouter-terminal-bridge-1.0.0.vsix
```

The extension starts automatically per editor window and registers itself on a dynamic port. The MCP server discovers active bridges via registry files in `~/.ccrouter/bridges/`.

## Usage

Once installed, every new Claude Code session automatically registers with CCRouter. The session's startup output will include something like:

```
[CCRouter] Session registered as "bold-bat"
```

From any session, use the MCP tools:

```
> list other sessions
> send a message to bold-bat saying "the build is done"
> read my messages
> read bold-bat's transcript
```

## How it works

1. **Registration** -- On SessionStart, a hook script walks the process tree to find the session's TTY, then POSTs to the daemon to register
2. **Identity** -- The MCP server identifies itself by matching its process tree's TTY against registered sessions in the SQLite database
3. **Messaging** -- Messages are stored in SQLite. If the Cursor extension is running, messages are also pushed directly into the target terminal via `sendSequence`
4. **Cleanup** -- The daemon periodically checks for dead PIDs and marks their sessions inactive

### Data storage

All runtime data lives in `~/.ccrouter/`:

- `ccrouter.db` -- SQLite database (sessions + messages)
- `bridges/` -- Bridge registry files (one per Cursor window)
- `hook-debug.log` -- Debug log from session hooks

## Uninstall

```bash
# Stop the daemon
launchctl bootout gui/$(id -u)/com.ccrouter.daemon

# Remove MCP server
claude mcp remove ccrouter

# Remove hooks from ~/.claude/settings.json (SessionStart and SessionEnd entries)
```

## License

MIT
