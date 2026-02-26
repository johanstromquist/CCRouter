import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_PROJECTS_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".claude",
  "projects"
);

function encodeCwd(cwd: string): string {
  // Claude Code encodes CWD by replacing / with -
  return cwd.replace(/\//g, "-");
}

interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export function readTranscript(
  sessionId: string,
  cwd: string,
  tail: number = 20
): TranscriptMessage[] {
  const projectDir = join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd));

  if (!existsSync(projectDir)) {
    return [];
  }

  // Look for the session's JSONL file
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  if (!existsSync(jsonlPath)) {
    return [];
  }

  const content = readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Claude Code JSONL format: each line has type, message with role and content
      if (entry.type === "user" || entry.type === "assistant") {
        const text = extractText(entry);
        if (text) {
          messages.push({ role: entry.type, content: text });
        }
      } else if (entry.message?.role && entry.message?.content) {
        const text = extractContentText(entry.message.content);
        if (text) {
          messages.push({ role: entry.message.role, content: text });
        }
      } else if (entry.role && entry.content) {
        const text = extractContentText(entry.content);
        if (text) {
          messages.push({ role: entry.role, content: text });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Return last N messages
  return messages.slice(-tail);
}

function extractText(entry: Record<string, unknown>): string | null {
  if (typeof entry.message === "object" && entry.message !== null) {
    const msg = entry.message as Record<string, unknown>;
    return extractContentText(msg.content);
  }
  if (typeof entry.content === "string") return entry.content;
  if (Array.isArray(entry.content)) return extractContentText(entry.content);
  return null;
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (
        typeof block === "object" &&
        block !== null &&
        "type" in block
      ) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

export function formatTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.role === "user" ? "USER" : "ASSISTANT";
      const text =
        m.content.length > 2000
          ? m.content.slice(0, 2000) + "... [truncated]"
          : m.content;
      return `[${prefix}]: ${text}`;
    })
    .join("\n\n---\n\n");
}

export function listSessionTranscripts(cwd: string): string[] {
  const projectDir = join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd));
  if (!existsSync(projectDir)) return [];

  return readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""));
}
