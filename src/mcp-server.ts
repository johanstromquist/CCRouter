import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer as createHttpServer } from "node:http";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { z } from "zod";
import {
  registerSession,
  getActiveSessions,
  resolveSession,
  updateSessionName,
  touchSession,
  getSessionById,
  getDb,
  joinChannel,
  leaveChannel,
  getChannelMembers,
  getChannelsForSession,
  isChannelMember,
  createInvite,
  getInvite,
  getPendingInvites,
  acceptInvite,
  declineInvite,
  sendChannelMessage,
  readChannelMessages,
  createPendingAck,
} from "./db.js";
import { readTranscript, formatTranscript } from "./transcript.js";
import { pushToTerminal, notifyBridges } from "./bridge.js";
import type { Session } from "./types.js";

/** Push a message to a session's terminal using all available routing info */
async function pushToSession(session: Session, text: string) {
  return pushToTerminal(text, {
    tty: session.tty || undefined,
    session_id: session.session_id,
    pid: session.pid || undefined,
  });
}

// Determine our session ID from environment or file
let currentSessionId: string | null =
  process.env.CCROUTER_SESSION_ID || null;

// Fallback: read session_id from file (Windows hooks write here since env vars
// don't propagate to the MCP server subprocess)
if (!currentSessionId) {
  const sidFile = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".ccrouter",
    "session_id"
  );
  try {
    currentSessionId = fs.readFileSync(sidFile, "utf-8").trim() || null;
  } catch {}
}

let currentSessionName: string | null = null;

/**
 * Walk up the process tree to find our tty, then look up the session by tty.
 * Unix-only: Windows has no tty concept and no `ps` command.
 */
function findSessionByProcessTree(): Session | undefined {
  // Windows: skip process tree walking entirely.
  // Session identification on Windows uses file-based session_id.
  if (process.platform === "win32") return undefined;

  let walkPid = process.pid;
  for (let i = 0; i < 5; i++) {
    try {
      const ppid = execSync(`ps -o ppid= -p ${walkPid}`, { encoding: "utf-8" }).trim();
      walkPid = parseInt(ppid, 10);
      if (!walkPid || walkPid <= 1) break;
      const tty = execSync(`ps -o tty= -p ${walkPid}`, { encoding: "utf-8" }).trim();
      if (tty && tty !== "??") {
        const db = getDb();
        const session = db
          .prepare("SELECT * FROM sessions WHERE tty = ? AND is_active = 1 ORDER BY last_seen_at DESC LIMIT 1")
          .get(tty) as Session | undefined;
        if (session) return session;
      }
    } catch {
      break;
    }
  }
  return undefined;
}

function ensureRegistered(): { id: string; name: string } {
  if (currentSessionId) {
    const s = getSessionById(currentSessionId);
    if (s) {
      touchSession(currentSessionId);
      return { id: currentSessionId, name: s.friendly_name };
    }
  }
  // Fallback: find session by walking the process tree to match tty
  const s = findSessionByProcessTree();
  if (s) {
    currentSessionId = s.session_id;
    touchSession(s.session_id);
    return { id: s.session_id, name: s.friendly_name };
  }
  throw new Error(
    "Session not registered. The session-start hook should have registered this session. " +
      "If not, call register_self with your session_id."
  );
}

const server = new McpServer({
  name: "ccrouter",
  version: "2.0.0",
});

// --- register_self: fallback if hook didn't set env var ---
server.tool(
  "register_self",
  "Register this session with CCRouter (use if session-start hook did not register automatically)",
  {
    session_id: z.string().describe("The Claude Code session ID"),
    cwd: z.string().optional().describe("Current working directory"),
    pid: z.number().optional().describe("Process ID"),
    tty: z.string().optional().describe("Terminal tty device (e.g. ttys095)"),
  },
  async (params) => {
    const session = registerSession({
      session_id: params.session_id,
      cwd: params.cwd,
      pid: params.pid,
      tty: params.tty,
    });
    currentSessionId = session.session_id;
    currentSessionName = session.friendly_name;

    // Notify bridges so they can map session_id to terminal
    notifyBridges({
      tty: session.tty || params.tty,
      session_id: session.session_id,
      friendly_name: session.friendly_name,
      cwd: session.cwd || params.cwd,
      pid: session.pid || params.pid,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Registered! Your name is "${session.friendly_name}". Other sessions can message you using this name.`,
        },
      ],
    };
  }
);

// --- install ---
server.tool(
  "install",
  "Install CCRouter on this machine. Downloads and installs the Cursor extension for push message delivery. Run this once on any new machine after adding the MCP.",
  {},
  async () => {
    // Determine the MCP server URL (SSE mode) from the connection context
    const mcpHost = process.env.CCROUTER_MCP_HOST || "0.0.0.0";
    const mcpPort = process.env.CCROUTER_MCP_PORT || "19920";
    // In SSE mode, we can serve the VSIX. In stdio mode, it's local.
    const isSSE = process.argv.includes("--sse");

    if (isSSE) {
      // Remote mode -- CC should download, install, and configure
      const serverIp = process.env.CCROUTER_ADVERTISE_IP || "192.168.68.87";
      const daemonPort = process.env.CCROUTER_DAEMON_PORT || "19919";
      const daemonUrl = `http://${serverIp}:${daemonPort}`;
      const extensionUrl = `http://${serverIp}:${mcpPort}/extension`;

      // Determine OS-appropriate temp path and config path
      const instructions = [
        "To complete CCRouter setup, run these commands:",
        "",
        "1. Download and install the Cursor extension:",
        `   curl -o ccrouter-bridge.vsix ${extensionUrl}`,
        `   cursor --install-extension ccrouter-bridge.vsix`,
        "",
        "2. Configure the extension to connect to the daemon:",
        `   Write this JSON to ~/.ccrouter/config.json:`,
        `   {"daemonUrl": "${daemonUrl}"}`,
        "",
        "   On Mac/Linux:",
        `   mkdir -p ~/.ccrouter && echo '{"daemonUrl":"${daemonUrl}"}' > ~/.ccrouter/config.json`,
        "",
        "   On Windows (PowerShell):",
        `   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.ccrouter" | Out-Null; '{"daemonUrl":"${daemonUrl}"}' | Set-Content "$env:USERPROFILE\\.ccrouter\\config.json"`,
        "",
        "3. Reload Cursor (Ctrl+Shift+P > Reload Window)",
        "",
        "4. Call register_self with your session_id",
        "",
        "After setup, other sessions can push messages directly to your terminal.",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: instructions }],
      };
    }

    // Local/stdio mode -- install directly
    const vsixPaths = [
      path.join(__dirname, "..", "cursor-extension", "ccrouter-terminal-bridge-1.0.0.vsix"),
      path.join(__dirname, "..", "..", "cursor-extension", "ccrouter-terminal-bridge-1.0.0.vsix"),
    ];
    let vsixPath: string | null = null;
    for (const p of vsixPaths) {
      try { fs.statSync(p); vsixPath = p; break; } catch {}
    }

    if (!vsixPath) {
      return {
        content: [{
          type: "text" as const,
          text: "VSIX file not found. Build it first: cd cursor-extension && npx @vscode/vsce package --allow-missing-repository",
        }],
      };
    }

    try {
      execSync(`cursor --install-extension "${vsixPath}"`, { encoding: "utf-8", timeout: 30000 });
      return {
        content: [{
          type: "text" as const,
          text: "CCRouter Cursor extension installed successfully. Reload Cursor to activate (Ctrl+Shift+P > Reload Window).",
        }],
      };
    } catch (err: any) {
      return {
        content: [{
          type: "text" as const,
          text: `Extension install failed: ${err.message}\n\nTry manually: cursor --install-extension "${vsixPath}"`,
        }],
      };
    }
  }
);

// --- who_am_i ---
server.tool(
  "who_am_i",
  "Show this session's identity in CCRouter",
  {},
  async () => {
    try {
      const { id, name } = ensureRegistered();
      const session = getSessionById(id);
      const channels = getChannelsForSession(name);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                friendly_name: name,
                session_id: id,
                cwd: session?.cwd,
                registered_at: session?.registered_at,
                channels: channels.map((c) => c.channel_name),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Not registered yet. ${(e as Error).message}`,
          },
        ],
      };
    }
  }
);

// --- list_sessions ---
server.tool(
  "list_sessions",
  "List all active Claude Code sessions (for discovery -- use invite_to_channel to communicate)",
  {},
  async () => {
    const sessions = getActiveSessions();

    // Build set of channels the calling session belongs to
    const me = currentSessionId
      ? getSessionById(currentSessionId)
      : findSessionByProcessTree();
    const myChannels = me
      ? new Set(getChannelsForSession(me.friendly_name).map((m) => m.channel_name))
      : new Set<string>();

    const lines = sessions.map((s) => {
      const marker = s.session_id === currentSessionId ? " (you)" : "";
      const cwd = s.cwd ? ` | cwd: ${s.cwd}` : "";
      const ide = s.ide_name ? ` | ide: ${s.ide_name}` : "";

      // Find shared channels with this session
      let shared = "";
      if (myChannels.size > 0 && s.session_id !== currentSessionId) {
        const theirChannels = getChannelsForSession(s.friendly_name).map((m) => m.channel_name);
        const overlap = theirChannels.filter((ch) => myChannels.has(ch));
        if (overlap.length > 0) {
          shared = ` | shared: ${overlap.join(", ")}`;
        }
      }

      return `${s.friendly_name}${marker}${cwd}${ide}${shared}`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            sessions.length === 0
              ? "No active sessions found."
              : lines.join("\n"),
        },
      ],
    };
  }
);

// --- get_session_info ---
server.tool(
  "get_session_info",
  "Get detailed information about a specific session",
  {
    name_or_id: z.string().describe("Session friendly name or session ID"),
  },
  async (params) => {
    const session = resolveSession(params.name_or_id);
    if (!session) {
      return {
        content: [
          { type: "text" as const, text: `Session "${params.name_or_id}" not found.` },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(session, null, 2),
        },
      ],
    };
  }
);

// --- set_session_name ---
server.tool(
  "set_session_name",
  "Change this session's friendly name",
  {
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe("New name (lowercase alphanumeric and hyphens only)"),
  },
  async (params) => {
    const { id } = ensureRegistered();
    const result = updateSessionName(id, params.name);
    if (result === true) {
      currentSessionName = params.name;

      // Notify bridges so they persist the new name for crash recovery
      const session = getSessionById(id);
      if (session) {
        notifyBridges({
          tty: session.tty || undefined,
          session_id: session.session_id,
          friendly_name: params.name,
          cwd: session.cwd || undefined,
        });
      }

      return {
        content: [
          { type: "text" as const, text: `Name changed to "${params.name}"` },
        ],
      };
    }
    const reason =
      result === "reserved"
        ? `Name "${params.name}" is reserved by a recently active session. Choose another.`
        : `Name "${params.name}" is already taken. Choose another.`;
    return {
      content: [
        { type: "text" as const, text: reason },
      ],
    };
  }
);

// --- read_session_transcript ---
server.tool(
  "read_session_transcript",
  "Read another session's conversation history",
  {
    name_or_id: z.string().describe("Target session friendly name or session ID"),
    tail: z
      .number()
      .optional()
      .default(20)
      .describe("Number of recent messages to return (default 20)"),
  },
  async (params) => {
    const session = resolveSession(params.name_or_id);
    if (!session) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Session "${params.name_or_id}" not found.`,
          },
        ],
      };
    }
    if (!session.cwd) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Session "${session.friendly_name}" has no CWD recorded -- cannot locate transcript.`,
          },
        ],
      };
    }

    const messages = readTranscript(
      session.session_id,
      session.cwd,
      params.tail
    );
    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No transcript found for session "${session.friendly_name}".`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Transcript for "${session.friendly_name}" (last ${messages.length} messages):\n\n${formatTranscript(messages)}`,
        },
      ],
    };
  }
);

// =====================================================================
// Channel tools
// =====================================================================

/** Ensure channel name starts with # */
function normalizeChannel(name: string): string {
  return name.startsWith("#") ? name : `#${name}`;
}


// --- invite_to_channel ---
server.tool(
  "invite_to_channel",
  "Invite another session to a channel. The channel materializes when the invite is accepted. You auto-join when you invite.",
  {
    channel: z
      .string()
      .describe('Channel name (e.g. "#deploy")'),
    target_name: z.string().describe("Friendly name of the session to invite"),
  },
  async (params) => {
    const { name } = ensureRegistered();
    const channel = normalizeChannel(params.channel);

    const target = resolveSession(params.target_name);
    if (!target) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Session "${params.target_name}" not found. Use list_sessions to see active sessions.`,
          },
        ],
      };
    }

    if (target.friendly_name === name) {
      return {
        content: [
          { type: "text" as const, text: "You cannot invite yourself." },
        ],
      };
    }

    // Auto-join the inviter to the channel
    joinChannel(channel, name);

    // Create the invite
    createInvite(channel, name, target.friendly_name);

    // Push-deliver the invitation
    const prompt = `[CCRouter] ${name} invited you to channel ${channel}. Use accept_invite to join.`;
    const result = await pushToSession(target, prompt);
    const pushStatus = result?.ok
      ? " (pushed to terminal)"
      : " (queued -- bridge unavailable)";

    return {
      content: [
        {
          type: "text" as const,
          text: `Invited "${target.friendly_name}" to ${channel}${pushStatus}`,
        },
      ],
    };
  }
);

// --- accept_invite ---
server.tool(
  "accept_invite",
  "Accept a pending channel invitation and join the channel",
  {
    channel: z.string().describe('Channel name to accept invite for (e.g. "#deploy")'),
  },
  async (params) => {
    const { name } = ensureRegistered();
    const channel = normalizeChannel(params.channel);

    // Look up the invite before accepting (to get inviter info)
    const invite = getInvite(channel, name);

    const accepted = acceptInvite(channel, name);
    if (!accepted) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No pending invitation for channel "${channel}".`,
          },
        ],
      };
    }

    // Get existing members before joining (these are who we notify)
    const existingMembers = getChannelMembers(channel);

    joinChannel(channel, name);
    const allMembers = getChannelMembers(channel);
    const memberNames = allMembers.map((m) => m.session_name).join(", ");

    // Notify existing channel members that someone joined
    for (const member of existingMembers) {
      if (member.session_name === name) continue;
      const session = resolveSession(member.session_name);
      if (session) {
        const prompt = `[${channel}] ${name} joined the channel.`;
        await pushToSession(session, prompt);
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Joined ${channel}. Members: ${memberNames}`,
        },
      ],
    };
  }
);

// --- decline_invite ---
server.tool(
  "decline_invite",
  "Decline a pending channel invitation",
  {
    channel: z.string().describe('Channel name to decline invite for (e.g. "#deploy")'),
  },
  async (params) => {
    const { name } = ensureRegistered();
    const channel = normalizeChannel(params.channel);

    // Look up the invite before declining (to get inviter info)
    const invite = getInvite(channel, name);

    const declined = declineInvite(channel, name);
    if (!declined) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No pending invitation for channel "${channel}".`,
          },
        ],
      };
    }

    // Notify the inviter that the invite was declined
    if (invite) {
      const inviter = resolveSession(invite.from_session);
      if (inviter) {
        const prompt = `[${channel}] ${name} declined the invitation.`;
        await pushToSession(inviter, prompt);
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Declined invitation to ${channel}.`,
        },
      ],
    };
  }
);

// --- send_message ---
server.tool(
  "send_message",
  "Send a message to a specific member or all members of a channel. Both sender and target must be members of the channel. Messages are pushed to terminals and automatically acknowledged -- if no ack is received within 30s, the system retries (first Enter, then a nudge). You will be notified if delivery ultimately fails.",
  {
    channel: z.string().describe('Channel context (e.g. "#deploy")'),
    to: z.string().optional().describe("Target session name. Omit to broadcast to all channel members."),
    message: z.string().describe("Message content"),
  },
  async (params) => {
    const { name } = ensureRegistered();
    const channel = normalizeChannel(params.channel);

    if (!isChannelMember(channel, name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `You are not a member of ${channel}. Join via accept_invite first.`,
          },
        ],
      };
    }

    // If targeting a specific member, verify they're in the channel
    if (params.to) {
      if (!isChannelMember(channel, params.to)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `"${params.to}" is not a member of ${channel}.`,
            },
          ],
        };
      }
    }

    const msg = sendChannelMessage(name, channel, params.message);

    // Determine recipients
    const members = getChannelMembers(channel);
    const targets = params.to
      ? members.filter((m) => m.session_name === params.to)
      : members.filter((m) => m.session_name !== name);
    let pushed = 0;

    for (const member of targets) {
      const session = resolveSession(member.session_name);
      if (session) {
        const prompt = `[${channel}] ${name}: ${params.message}`;
        const result = await pushToSession(session, prompt);
        if (result?.ok) {
          pushed++;
          createPendingAck(msg.id, channel, name, member.session_name, session.tty || "", session.session_id);
        }
      }
    }

    const target = params.to ? params.to : "all";
    const pushStatus =
      targets.length > 0
        ? ` (pushed to ${pushed}/${targets.length})`
        : params.to
          ? ` (${params.to} not reachable)`
          : " (no other members in channel)";

    return {
      content: [
        {
          type: "text" as const,
          text: `Message sent to ${target} in ${channel} (id: ${msg.id})${pushStatus}`,
        },
      ],
    };
  }
);

// --- read_messages ---
server.tool(
  "read_messages",
  "Read messages from channels you are a member of",
  {
    channel: z
      .string()
      .optional()
      .describe('Specific channel to read from, e.g. "#deploy" (omit for all channels)'),
    include_read: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include already-read messages"),
  },
  async (params) => {
    const { name } = ensureRegistered();

    let channels: string[];
    if (params.channel) {
      const channel = normalizeChannel(params.channel);
      if (!isChannelMember(channel, name)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `You are not a member of ${channel}.`,
            },
          ],
        };
      }
      channels = [channel];
    } else {
      const memberships = getChannelsForSession(name);
      channels = memberships.map((m) => m.channel_name);
    }

    const messages = readChannelMessages(name, channels, !params.include_read);

    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: params.include_read
              ? "No messages found."
              : "No unread messages.",
          },
        ],
      };
    }

    const formatted = messages
      .map(
        (m) => `[${m.created_at}] [${m.channel}] ${m.from_session}: ${m.content}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

// --- leave_channel ---
server.tool(
  "leave_channel",
  "Leave a channel. The channel dissolves when all members leave.",
  {
    channel: z.string().describe('Channel name to leave (e.g. "#deploy")'),
  },
  async (params) => {
    const { name } = ensureRegistered();
    const channel = normalizeChannel(params.channel);

    if (!isChannelMember(channel, name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `You are not a member of ${channel}.`,
          },
        ],
      };
    }

    leaveChannel(channel, name);
    const remaining = getChannelMembers(channel);

    // Notify remaining members
    for (const member of remaining) {
      const session = resolveSession(member.session_name);
      if (session) {
        const prompt = `[${channel}] ${name} left the channel.`;
        await pushToSession(session, prompt);
      }
    }

    let dissolution = "";
    if (remaining.length === 0) {
      dissolution = " Channel dissolved (no remaining members).";
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Left ${channel}.${dissolution}`,
        },
      ],
    };
  }
);

// --- list_channels ---
server.tool(
  "list_channels",
  "List channels you are a member of and their members",
  {},
  async () => {
    const { name } = ensureRegistered();

    const memberships = getChannelsForSession(name);
    if (memberships.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "You are not a member of any channels.",
          },
        ],
      };
    }

    const lines: string[] = [];
    for (const m of memberships) {
      const members = getChannelMembers(m.channel_name);
      const memberNames = members
        .map((cm) =>
          cm.session_name === name
            ? `${cm.session_name} (you)`
            : cm.session_name
        )
        .join(", ");
      lines.push(`${m.channel_name}: ${memberNames}`);
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- list_invites ---
server.tool(
  "list_invites",
  "List pending channel invitations for this session",
  {},
  async () => {
    const { name } = ensureRegistered();

    const invites = getPendingInvites(name);
    if (invites.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No pending invitations." },
        ],
      };
    }

    const lines = invites.map(
      (inv) =>
        `${inv.channel_name} -- invited by ${inv.from_session} (${inv.created_at})`
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Start server ---
async function main() {
  const mode = process.argv.includes("--sse") ? "sse" : "stdio";

  if (mode === "sse") {
    // Network mode: SSE transport for remote CC sessions
    const SSE_PORT = parseInt(process.env.CCROUTER_MCP_PORT || "19920", 10);
    const SSE_HOST = process.env.CCROUTER_MCP_HOST || "0.0.0.0";

    // Track active SSE transports per session
    const transports = new Map<string, SSEServerTransport>();

    const httpServer = createHttpServer(async (req, res) => {
      // CORS for cross-origin requests from remote machines
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/sse" && req.method === "GET") {
        // New SSE connection -- each remote CC gets its own transport + server
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);

        transport.onclose = () => {
          transports.delete(transport.sessionId);
        };

        // Each connection needs its own McpServer because McpServer
        // can only be connected to one transport at a time.
        // We import the tool definitions via the shared `server` setup.
        // For simplicity, connect the shared server to the latest transport.
        // This means only one remote session at a time is fully active.
        // TODO: support multiple concurrent remote sessions
        await server.connect(transport);
        // connect() calls start() internally -- do NOT call start() again
      } else if (req.url?.startsWith("/messages") && req.method === "POST") {
        // Route POST to the correct transport by sessionId query param
        const url = new URL(req.url, `http://localhost:${SSE_PORT}`);
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? transports.get(sessionId) : transports.values().next().value;
        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(404);
          res.end("No active SSE session");
        }
      } else if (req.url === "/extension" && req.method === "GET") {
        // Serve the VSIX file for remote installation
        const vsixPaths = [
          path.join(__dirname, "..", "cursor-extension", "ccrouter-terminal-bridge-1.0.0.vsix"),
          path.join(__dirname, "..", "..", "cursor-extension", "ccrouter-terminal-bridge-1.0.0.vsix"),
          path.join(process.env.HOME || "", ".ccrouter", "ccrouter-terminal-bridge-1.0.0.vsix"),
        ];
        let vsixPath: string | null = null;
        for (const p of vsixPaths) {
          try { fs.statSync(p); vsixPath = p; break; } catch {}
        }
        if (vsixPath) {
          const data = fs.readFileSync(vsixPath);
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment; filename=ccrouter-terminal-bridge-1.0.0.vsix",
            "Content-Length": data.length,
          });
          res.end(data);
        } else {
          res.writeHead(404);
          res.end("Extension VSIX not found on server");
        }
      } else if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          mode: "sse",
          activeSessions: transports.size,
        }));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    httpServer.listen(SSE_PORT, SSE_HOST, () => {
      console.log(`CCRouter MCP server (SSE) listening on http://${SSE_HOST}:${SSE_PORT}`);
      console.log(`Remote CC: claude mcp add ccrouter --transport sse --url http://<this-ip>:${SSE_PORT}/sse`);
    });
  } else {
    // Local mode: stdio transport (default, used by local CC sessions)
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // If we have a session ID, try to look up our name from the DB
    if (currentSessionId) {
      const s = getSessionById(currentSessionId);
      if (s) {
        currentSessionName = s.friendly_name;
      }
    }
  }
}

main().catch((err) => {
  console.error("CCRouter MCP server failed to start:", err);
  process.exit(1);
});
