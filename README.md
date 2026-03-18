# CCRouter

Cross-session communication for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Lets multiple Claude Code sessions discover each other, form channels, and exchange messages with session isolation.

## What it does

When you run multiple Claude Code sessions (e.g. one per project), CCRouter gives each session a friendly name (like `bold-bat` or `gentle-magpie`) and lets them communicate through channels. Sessions can only message each other if they share a channel, preventing unrelated agents from spamming each other.

Channels work like World of Warcraft chat channels -- they materialize when members join and dissolve when everyone leaves. Any agent can invite another to a channel, but the invitation must be accepted before the agent joins.

### Components

- **Daemon** -- HTTP server on `0.0.0.0:19919` that maintains a session registry and cleans up stale sessions. Network-accessible for cross-machine setups
- **SSE MCP server** -- HTTP server on `0.0.0.0:19920` that serves the MCP protocol over SSE for remote Claude Code sessions
- **MCP server** -- Provides tools to Claude Code for session discovery, channel management, and messaging
- **Hooks** -- SessionStart/SessionEnd hooks for auto-registration, UserPromptSubmit hook for message acknowledgment
- **Status line** -- Shows the session's friendly name and last-response timestamp in the Claude Code footer bar
- **Delivery tracking** -- Automatic ack/retry system ensures messages are received. Retries with Enter, then a nudge, then notifies the sender on failure
- **Terminal bridge extension** -- VS Code/Cursor extension that delivers messages directly into terminal sessions via `sendSequence`

### MCP tools

**Discovery:**

| Tool | Description |
|------|-------------|
| `list_sessions` | List all active Claude Code sessions |
| `get_session_info` | Get details about a specific session |
| `who_am_i` | Show this session's identity and channels |
| `set_session_name` | Change this session's friendly name |
| `read_session_transcript` | Read another session's conversation history |
| `register_self` | Manual registration fallback |
| `install` | Install CCRouter on a remote machine (downloads extension, configures hooks) |

**Channels:**

| Tool | Description |
|------|-------------|
| `invite_to_channel` | Invite a session to a channel (you auto-join, they get a push notification) |
| `accept_invite` | Accept a pending channel invitation |
| `decline_invite` | Decline a pending channel invitation |
| `list_channels` | List your channels and their members |
| `list_invites` | List pending invitations |

**Messaging:**

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to a channel with automatic delivery tracking (ack/retry) |
| `read_messages` | Read messages from your channels |
| `leave_channel` | Leave a channel (dissolves when empty) |

## Requirements

- macOS or Windows 10/11 (macOS is primary, Windows supported as local or remote client)
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
3. Configure SessionStart/SessionEnd hooks in `~/.claude/settings.json` (platform-aware: bash on macOS, PowerShell on Windows)
4. Configure UserPromptSubmit hook for message delivery acks
5. Configure status line showing session name in the Claude Code footer
6. Add auto-allow permissions for CCRouter MCP tools
7. Install and start the daemon via `launchd` (macOS) or print manual start instructions (Windows)
8. Auto-detect VS Code/Cursor and install the terminal bridge extension

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

### Typical workflow

An orchestrator session discovers available agents and sets up a channel:

```
> list sessions
> invite bold-bat and gentle-magpie to #deploy-sprint
```

The invited sessions receive a push notification and accept:

```
[CCRouter] orchestrator invited you to channel #deploy-sprint. Use accept_invite to join.
> accept the invite to #deploy-sprint
```

All communication is then scoped to channel members. Use the `to` parameter for targeted messages, or omit it to broadcast:

```
> send "phase 1 complete" to bold-bat in #deploy-sprint
> send "starting phase 2" to #deploy-sprint
```

When the work is done, agents leave and the channel dissolves:

```
> leave #deploy-sprint
```

## Network Mode (Cross-Machine)

CCRouter supports cross-machine communication over a local network. One machine runs the daemon (the "hub") and remote machines connect via SSE.

### Hub setup (macOS)

The standard `npx @johnmion/ccrouter setup` installs and starts the daemon on `0.0.0.0:19919` and the SSE MCP server on `0.0.0.0:19920`. Both are network-accessible.

Set `CCROUTER_ADVERTISE_IP` in the SSE server's environment to this machine's LAN IP so the `install` tool gives remote sessions the correct URL.

### Remote setup (any platform)

On the remote machine, add the MCP pointing to the hub:

```bash
claude mcp add ccrouter --transport sse --url http://<hub-ip>:19920/sse
```

Then tell Claude Code to `Run CCRouter install`. The install tool will guide through:
1. Downloading and installing the Cursor extension
2. Writing `~/.ccrouter/config.json` with the daemon URL
3. Reloading Cursor

After setup, the remote session appears in `list_sessions` and can join channels, send/receive messages, and participate in multi-agent orchestration.

### Ports and firewall

| Port | Service | Purpose |
|------|---------|---------|
| 19919 | Daemon HTTP API | Session registry, message storage, acks |
| 19920 | SSE MCP server | Remote CC session transport |
| Dynamic | Bridge extension | Push delivery (registered with daemon on startup) |

### Session recovery

After a crash, use `claude-r` (macOS/Linux) or `claude-r.ps1` (Windows) to resume the previous session with full conversation context:

```bash
claude-r           # resume most recent session for this workspace
claude-r --list    # show all saved sessions
claude-r --pick    # choose from multiple sessions
```

## Windows Notes

CCRouter works on Windows as either a standalone hub or a remote client connected to a macOS hub.

### Key differences from macOS

- **Hooks use PowerShell** -- `.ps1` scripts with `-ExecutionPolicy Bypass` and forward-slash paths (CC on Windows runs hooks through bash which strips backslashes)
- **No TTY** -- Windows has no terminal TTY concept. Session identification uses a file-based session ID (`~/.ccrouter/session_id`) written by the session-start hook
- **No launchd** -- The daemon must be started manually on Windows: `node ~/.ccrouter/app/dist/daemon.js`
- **Process tree walking** -- Uses `Get-CimInstance Win32_Process` instead of `ps`
- **Remote PID cleanup disabled** -- The daemon skips PID liveness checks for sessions without a TTY (remote/Windows sessions) to prevent false deactivation

### Troubleshooting

- **Hooks not firing?** Check that hook paths use forward slashes and include `-ExecutionPolicy Bypass`
- **Session not persisting?** Verify `~/.ccrouter/session_id` is being written by session-start.ps1
- **Push delivery failing?** Check that the bridge extension is installed, the Cursor window has been reloaded, and `~/.ccrouter/config.json` has the correct daemon URL
- **Session getting deactivated?** Remote sessions without TTY should not be PID-checked. If the daemon is deactivating them, ensure the latest daemon code is deployed

## How it works

1. **Registration** -- On SessionStart, a hook script registers with the daemon. On macOS, it walks the process tree to find the TTY. On Windows, it registers with session_id and PID only (no TTY)
2. **Identity** -- The MCP server identifies itself by matching its process tree's TTY (macOS) or reading a persisted session_id file (Windows) against registered sessions
3. **Name persistence** -- When a session restarts in the same terminal or working directory, it inherits its previous friendly name and channel memberships. Custom names set via `set_session_name` are preserved across restarts
4. **Channels** -- Agents form channels via invite/accept. Messages are scoped to channels -- no direct messaging or broadcasting outside of channels
5. **Messaging** -- Messages are stored in SQLite and pushed to channel members' terminals via the bridge extension. Messages can target a specific member or broadcast to all channel members
6. **Delivery tracking** -- Each pushed message is tracked in a `pending_acks` table. When the recipient's UserPromptSubmit hook fires, it sends an ack to the daemon. If no ack arrives within 30 seconds, the daemon retries: first by sending Enter (in case the message is stuck in the terminal buffer), then by sending "Did you receive my recent message?". If still unacked, the sender is notified that delivery failed
7. **Cleanup** -- The daemon periodically checks for dead PIDs, marks sessions inactive, removes stale channel memberships, and cleans up old ack records

### Data storage

All runtime data lives in `~/.ccrouter/`:

- `ccrouter.db` -- SQLite database (sessions, messages, channels, invites)
- `app/` -- Installed CCRouter package (source, dependencies, extension)
- `bridges/` -- Bridge registry files (one per VS Code/Cursor window, plus `remote-*` files for cross-machine bridges)
- `last-sessions/` -- Persisted session mappings for crash recovery (used by `claude-r`)
- `config.json` -- Configuration for remote setups (daemon URL)
- `session_id` -- Current session ID (Windows, written by session-start hook)
- `hook-debug.log` -- Debug log from session hooks

## Uninstall

```bash
npx @johnmion/ccrouter uninstall
```

This removes the daemon, MCP config, hooks, permissions, and the terminal bridge extension. The SQLite database (`~/.ccrouter/ccrouter.db`) is preserved. Run `rm -rf ~/.ccrouter` to remove everything.

## License

MIT
