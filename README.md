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
npx @johnmion/ccrouter setup
```

This single command will:

1. Copy CCRouter to `~/.ccrouter/app/` and install dependencies
2. Register the MCP server with Claude Code (`claude mcp add`)
3. Configure SessionStart/SessionEnd hooks in `~/.claude/settings.json`
4. Add auto-allow permissions for CCRouter MCP tools
5. Install and start the daemon via `launchd`
6. Auto-detect VS Code/Cursor and install the terminal bridge extension

The terminal bridge extension is required for message delivery -- it pushes messages directly into the target session's terminal via VS Code's `sendSequence` API. Without it, messages are stored but the recipient has no way to see them.

### Verify

```bash
curl http://127.0.0.1:19919/health
```

### From source

If you prefer to install from a git clone:

```bash
git clone https://github.com/johanstromquist/CCRouter.git
cd CCRouter
npm install
npm run build
node dist/cli.js setup
```

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
3. **Messaging** -- Messages are stored in SQLite. If the terminal bridge extension is running, messages are also pushed directly into the target terminal via `sendSequence`
4. **Cleanup** -- The daemon periodically checks for dead PIDs and marks their sessions inactive

### Data storage

All runtime data lives in `~/.ccrouter/`:

- `ccrouter.db` -- SQLite database (sessions + messages)
- `app/` -- Installed CCRouter package (source, dependencies, extension)
- `bridges/` -- Bridge registry files (one per VS Code/Cursor window)
- `hook-debug.log` -- Debug log from session hooks

## Uninstall

```bash
npx @johnmion/ccrouter uninstall
```

This removes the daemon, MCP config, hooks, permissions, and the terminal bridge extension. The SQLite database (`~/.ccrouter/ccrouter.db`) is preserved. Run `rm -rf ~/.ccrouter` to remove everything.

## License

MIT
