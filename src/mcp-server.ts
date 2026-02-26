import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "node:child_process";
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
  getPendingInvites,
  acceptInvite,
  declineInvite,
  sendChannelMessage,
  readChannelMessages,
} from "./db.js";
import { readTranscript, formatTranscript } from "./transcript.js";
import { pushToTerminal } from "./bridge.js";
import type { Session } from "./types.js";

// Determine our session ID from environment
let currentSessionId: string | null =
  process.env.CCROUTER_SESSION_ID || null;
let currentSessionName: string | null = null;

/**
 * Walk up the process tree to find our tty, then look up the session by tty.
 */
function findSessionByProcessTree(): Session | undefined {
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
  if (currentSessionId && currentSessionName) {
    touchSession(currentSessionId);
    return { id: currentSessionId, name: currentSessionName };
  }
  if (currentSessionId) {
    const s = getSessionById(currentSessionId);
    if (s) {
      currentSessionName = s.friendly_name;
      touchSession(currentSessionId);
      return { id: currentSessionId, name: currentSessionName };
    }
  }
  // Fallback: find session by walking the process tree to match tty
  const s = findSessionByProcessTree();
  if (s) {
    currentSessionId = s.session_id;
    currentSessionName = s.friendly_name;
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
    const lines = sessions.map((s) => {
      const marker = s.session_id === currentSessionId ? " (you)" : "";
      const cwd = s.cwd ? ` | cwd: ${s.cwd}` : "";
      const ide = s.ide_name ? ` | ide: ${s.ide_name}` : "";
      return `${s.friendly_name}${marker}${cwd}${ide}`;
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
    const ok = updateSessionName(id, params.name);
    if (ok) {
      currentSessionName = params.name;
      return {
        content: [
          { type: "text" as const, text: `Name changed to "${params.name}"` },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Name "${params.name}" is already taken. Choose another.`,
        },
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

// --- invite_to_channel ---
server.tool(
  "invite_to_channel",
  "Invite another session to a channel. The channel materializes when the invite is accepted. You auto-join when you invite.",
  {
    channel: z
      .string()
      .regex(/^#[a-z0-9-]+$/)
      .describe('Channel name (must start with #, e.g. "#deploy")'),
    target_name: z.string().describe("Friendly name of the session to invite"),
  },
  async (params) => {
    const { name } = ensureRegistered();

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
    joinChannel(params.channel, name);

    // Create the invite
    createInvite(params.channel, name, target.friendly_name);

    // Push-deliver the invitation
    let pushStatus = "";
    if (target.tty) {
      const prompt = `[CCRouter] ${name} invited you to channel ${params.channel}. Use accept_invite to join.`;
      const result = await pushToTerminal(target.tty, prompt);
      pushStatus = result?.ok
        ? " (pushed to terminal)"
        : " (queued -- bridge unavailable)";
    } else {
      pushStatus = " (queued -- no tty)";
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Invited "${target.friendly_name}" to ${params.channel}${pushStatus}`,
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
    channel: z.string().describe("Channel name to accept invite for"),
  },
  async (params) => {
    const { name } = ensureRegistered();

    const accepted = acceptInvite(params.channel, name);
    if (!accepted) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No pending invitation for channel "${params.channel}".`,
          },
        ],
      };
    }

    joinChannel(params.channel, name);
    const members = getChannelMembers(params.channel);
    const memberNames = members.map((m) => m.session_name).join(", ");

    return {
      content: [
        {
          type: "text" as const,
          text: `Joined ${params.channel}. Members: ${memberNames}`,
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
    channel: z.string().describe("Channel name to decline invite for"),
  },
  async (params) => {
    const { name } = ensureRegistered();

    const declined = declineInvite(params.channel, name);
    if (!declined) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No pending invitation for channel "${params.channel}".`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Declined invitation to ${params.channel}.`,
        },
      ],
    };
  }
);

// --- send_message ---
server.tool(
  "send_message",
  "Send a message to all members of a channel (you must be a member)",
  {
    channel: z.string().describe("Channel to send message to"),
    message: z.string().describe("Message content"),
  },
  async (params) => {
    const { name } = ensureRegistered();

    if (!isChannelMember(params.channel, name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `You are not a member of ${params.channel}. Join via accept_invite first.`,
          },
        ],
      };
    }

    const msg = sendChannelMessage(name, params.channel, params.message);

    // Push to all other members' terminals
    const members = getChannelMembers(params.channel);
    const otherMembers = members.filter((m) => m.session_name !== name);
    let pushed = 0;

    for (const member of otherMembers) {
      const session = resolveSession(member.session_name);
      if (session?.tty) {
        const prompt = `[${params.channel}] ${name}: ${params.message}`;
        const result = await pushToTerminal(session.tty, prompt);
        if (result?.ok) pushed++;
      }
    }

    const pushStatus =
      otherMembers.length > 0
        ? ` (pushed to ${pushed}/${otherMembers.length} members)`
        : " (no other members in channel)";

    return {
      content: [
        {
          type: "text" as const,
          text: `Message sent to ${params.channel} (id: ${msg.id})${pushStatus}`,
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
      .describe("Specific channel to read from (omit for all channels)"),
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
      if (!isChannelMember(params.channel, name)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `You are not a member of ${params.channel}.`,
            },
          ],
        };
      }
      channels = [params.channel];
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
    channel: z.string().describe("Channel name to leave"),
  },
  async (params) => {
    const { name } = ensureRegistered();

    if (!isChannelMember(params.channel, name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `You are not a member of ${params.channel}.`,
          },
        ],
      };
    }

    leaveChannel(params.channel, name);
    const remaining = getChannelMembers(params.channel);

    let dissolution = "";
    if (remaining.length === 0) {
      dissolution = " Channel dissolved (no remaining members).";
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Left ${params.channel}.${dissolution}`,
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

main().catch((err) => {
  console.error("CCRouter MCP server failed to start:", err);
  process.exit(1);
});
