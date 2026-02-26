import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "node:child_process";
import { z } from "zod";
import {
  registerSession,
  getActiveSessions,
  resolveSession,
  sendMessage,
  readMessages,
  updateSessionName,
  touchSession,
  getSessionById,
  getDb,
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
  version: "1.0.0",
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
  "List all active Claude Code sessions",
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

// --- send_message ---
server.tool(
  "send_message",
  'Send a message to another session by name, or "*" to broadcast',
  {
    to: z
      .string()
      .describe('Target session friendly name, session ID, or "*" for broadcast'),
    message: z.string().describe("Message content"),
  },
  async (params) => {
    const { name } = ensureRegistered();

    // Validate target exists (unless broadcast)
    if (params.to !== "*") {
      const target = resolveSession(params.to);
      if (!target) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Session "${params.to}" not found. Use list_sessions to see active sessions.`,
            },
          ],
        };
      }
      // Store message in DB
      const msg = sendMessage(name, target.friendly_name, params.message);

      // Attempt push delivery via terminal bridge
      let pushStatus = "";
      if (target.tty) {
        const prompt = `[CCRouter message from ${name}]: ${params.message}`;
        const result = await pushToTerminal(target.tty, prompt);
        if (result?.ok) {
          pushStatus = " (pushed to terminal)";
        } else {
          pushStatus = " (queued -- bridge unavailable or terminal not found)";
        }
      } else {
        pushStatus = " (queued -- no tty registered for target)";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to "${target.friendly_name}" (id: ${msg.id})${pushStatus}`,
          },
        ],
      };
    }

    // Broadcast: store message, then push to all sessions with ttys
    const msg = sendMessage(name, "*", params.message);
    const sessions = getActiveSessions().filter(
      (s) => s.session_id !== currentSessionId && s.tty
    );
    let pushed = 0;
    for (const s of sessions) {
      const prompt = `[CCRouter broadcast from ${name}]: ${params.message}`;
      const result = await pushToTerminal(s.tty!, prompt);
      if (result?.ok) pushed++;
    }
    const pushStatus =
      sessions.length > 0
        ? ` (pushed to ${pushed}/${sessions.length} sessions)`
        : " (no other sessions to push to)";

    return {
      content: [
        {
          type: "text" as const,
          text: `Broadcast message sent (id: ${msg.id})${pushStatus}`,
        },
      ],
    };
  }
);

// --- read_messages ---
server.tool(
  "read_messages",
  "Read messages sent to this session",
  {
    include_read: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include already-read messages"),
  },
  async (params) => {
    const { id, name } = ensureRegistered();
    const messages = readMessages(name, id, !params.include_read);

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
        (m) =>
          `[${m.created_at}] From ${m.from_session}: ${m.content}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
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
