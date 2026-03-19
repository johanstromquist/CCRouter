import Database from "better-sqlite3";
import type { Session } from "./types.js";
import { generateName } from "./names.js";
import { isProcessAlive } from "./lock-scanner.js";
import { createLogger } from "./logger.js";

const log = createLogger("session");

/**
 * Determine the friendly name for a new session by checking (in priority order):
 *   1. desired_name from hook/file
 *   2. CWD match against dead-PID or recently inactive sessions
 *   3. Generate a fresh adjective-animal name
 *
 * Also cleans up stale predecessor sessions as a side effect.
 */
export function resolveSessionName(
  db: Database.Database,
  opts: {
    session_id: string;
    cwd?: string;
    desired_name?: string;
  }
): { name: string; isCustom: boolean } {
  let friendlyName: string | null = null;
  let nameIsCustom = false;

  // Normalize Windows paths (backslash -> forward slash) so cwd matching works
  const normalizedCwd = opts.cwd?.replace(/\\/g, "/");

  // 0. Desired name (highest priority -- hook read from persisted session file)
  if (opts.desired_name) {
    const activeTaken = db
      .prepare(
        "SELECT session_id FROM sessions WHERE friendly_name = ? AND is_active = 1 AND session_id != ?"
      )
      .get(opts.desired_name, opts.session_id) as { session_id: string } | undefined;

    if (!activeTaken) {
      const inactive = db
        .prepare(
          "SELECT session_id FROM sessions WHERE friendly_name = ? AND is_active = 0"
        )
        .get(opts.desired_name) as { session_id: string } | undefined;
      if (inactive) {
        db.prepare("DELETE FROM sessions WHERE session_id = ?").run(inactive.session_id);
      }
      friendlyName = opts.desired_name;
      nameIsCustom = true;
      log.debug(`Re-identified (desired_name): claiming "${friendlyName}"`, {
        session_id: opts.session_id,
      });
    } else {
      log.debug(`desired_name "${opts.desired_name}" taken by active session`, {
        taken_by: activeTaken.session_id,
      });
    }
  }

  // 1. CWD match (clean up stale sessions, inherit name)
  if (!friendlyName && normalizedCwd) {
    // Clean up active sessions in this cwd with dead PIDs
    const activeSameCwd = db
      .prepare(
        `SELECT * FROM sessions
         WHERE cwd = ? AND is_active = 1 AND session_id != ?
         ORDER BY last_seen_at DESC`
      )
      .all(normalizedCwd, opts.session_id) as Session[];

    for (const candidate of activeSameCwd) {
      if (candidate.pid && !isProcessAlive(candidate.pid)) {
        if (!friendlyName) {
          friendlyName = candidate.friendly_name;
          log.debug(`Re-identified (cwd match, dead pid): transferring name "${friendlyName}"`, {
            from: candidate.session_id,
            to: opts.session_id,
          });
        }
        db.prepare("DELETE FROM sessions WHERE session_id = ?").run(
          candidate.session_id
        );
      }
    }

    // Check recently inactive sessions by cwd.
    // Only inherit if exactly one candidate (ambiguous = skip).
    if (!friendlyName) {
      const candidates = db
        .prepare(
          `SELECT * FROM sessions
           WHERE cwd = ? AND is_active = 0 AND session_id != ?
             AND last_seen_at > datetime('now', '-24 hours')
             ORDER BY name_custom DESC, last_seen_at DESC`
        )
        .all(normalizedCwd, opts.session_id) as Session[];

      if (candidates.length === 1) {
        friendlyName = candidates[0].friendly_name;
        db.prepare("DELETE FROM sessions WHERE session_id = ?").run(
          candidates[0].session_id
        );
        log.debug(`Re-identified (cwd match, inactive): transferring name "${friendlyName}"`, {
          from: candidates[0].session_id,
          to: opts.session_id,
        });
      } else if (candidates.length > 1) {
        log.debug(`Ambiguous cwd match, skipping re-identification`, {
          cwd: normalizedCwd,
          candidate_count: candidates.length,
        });
      }
    }
  }

  // Generate a new name only if we didn't inherit one
  if (!friendlyName) {
    const existingNames = new Set(
      (
        db.prepare("SELECT friendly_name FROM sessions").all() as {
          friendly_name: string;
        }[]
      ).map((r) => r.friendly_name)
    );
    friendlyName = generateName(existingNames);
  }

  return { name: friendlyName, isCustom: nameIsCustom };
}

/**
 * Canonical "who am I" for the MCP server.
 *
 * Queries the daemon for the session registered with this CC instance's PID.
 * The session-start hook registers with the daemon including the CC process PID.
 * The MCP server is a child of CC, so process.ppid gives the CC PID.
 * The daemon looks up: WHERE pid = ppid AND is_active = 1.
 *
 * Platform-agnostic: process.ppid works on Mac, Linux, and Windows.
 * No env vars, no shared files.
 *
 * Fallback: register_self (called explicitly by the user or by CC).
 */
export function resolveCurrentSession(
  db: Database.Database
): { id: string; name: string } {
  const ppid = process.ppid;

  // Query daemon by parent PID
  const s = db
    .prepare(
      "SELECT * FROM sessions WHERE pid = ? AND is_active = 1 ORDER BY last_seen_at DESC LIMIT 1"
    )
    .get(ppid) as Session | undefined;

  if (s) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?").run(
      new Date().toISOString(),
      s.session_id
    );
    return { id: s.session_id, name: s.friendly_name };
  }

  throw new Error(
    "Session not registered. The session-start hook should have registered this session. " +
      "If not, call register_self with your session_id."
  );
}
