import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Session } from "./types.js";
import { generateName } from "./names.js";
import { isProcessAlive } from "./lock-scanner.js";
import { isWindows } from "./platform.js";
import { createLogger } from "./logger.js";

const log = createLogger("session");

/**
 * Walk up the process tree starting from `startPid` to find a tty.
 * Unix-only: returns null on Windows (no tty concept / no `ps` command).
 */
export function findTtyByProcessTree(startPid: number): string | null {
  if (isWindows()) return null;

  let walkPid = startPid;
  for (let i = 0; i < 5; i++) {
    try {
      const ppid = execSync(`ps -o ppid= -p ${walkPid}`, { encoding: "utf-8" }).trim();
      walkPid = parseInt(ppid, 10);
      if (!walkPid || walkPid <= 1) break;
      const tty = execSync(`ps -o tty= -p ${walkPid}`, { encoding: "utf-8" }).trim();
      if (tty && tty !== "??") {
        return tty;
      }
    } catch {
      break;
    }
  }
  return null;
}

/**
 * Determine the friendly name for a new session by checking (in priority order):
 *   1. desired_name from hook/file
 *   2. TTY match against inactive predecessors
 *   3. CWD match against dead-PID or recently inactive sessions
 *   4. Generate a fresh adjective-animal name
 *
 * Also cleans up stale predecessor sessions as a side effect.
 */
export function resolveSessionName(
  db: Database.Database,
  opts: {
    session_id: string;
    tty?: string;
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

  // 1. TTY match (most reliable on Mac -- same terminal = same session)
  if (!friendlyName && opts.tty) {
    const ttyPredecessors = db
      .prepare(
        `SELECT * FROM sessions
         WHERE tty = ? AND is_active = 0 AND session_id != ?
         ORDER BY name_custom DESC, last_seen_at DESC`
      )
      .all(opts.tty, opts.session_id) as Session[];

    if (ttyPredecessors.length > 0) {
      const predecessor = ttyPredecessors[0];
      friendlyName = predecessor.friendly_name;
      nameIsCustom = !!(predecessor.name_custom);
      for (const pred of ttyPredecessors) {
        db.prepare("DELETE FROM sessions WHERE session_id = ?").run(pred.session_id);
      }
      log.debug(`Re-identified (tty match): transferring name "${friendlyName}"`, {
        from: predecessor.session_id,
        to: opts.session_id,
      });
    }
  }

  // 2. CWD match (fallback -- clean up stale sessions, inherit name)
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
 * Resolution order:
 *   1. CCROUTER_SESSION_ID env var
 *   2. session_id file (~/.ccrouter/session_id)
 *   3. Process tree TTY match (Unix only)
 *   4. Throws if nothing works
 */
export function resolveCurrentSession(
  db: Database.Database
): { id: string; name: string } {
  // 1. Env var
  const envId = process.env.CCROUTER_SESSION_ID || null;
  if (envId) {
    const s = db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(envId) as Session | undefined;
    if (s) {
      db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?").run(
        new Date().toISOString(),
        envId
      );
      return { id: envId, name: s.friendly_name };
    }
  }

  // 2. session_id file (Windows hooks write here since env vars
  //    don't propagate to the MCP server subprocess)
  const sidFile = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".ccrouter",
    "session_id"
  );
  try {
    const fileId = fs.readFileSync(sidFile, "utf-8").trim();
    if (fileId) {
      const s = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(fileId) as Session | undefined;
      if (s) {
        db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?").run(
          new Date().toISOString(),
          fileId
        );
        return { id: fileId, name: s.friendly_name };
      }
    }
  } catch {
    // No file -- fall through
  }

  // 3. Process tree TTY match (Unix only)
  const tty = findTtyByProcessTree(process.pid);
  if (tty) {
    const s = db
      .prepare(
        "SELECT * FROM sessions WHERE tty = ? AND is_active = 1 ORDER BY last_seen_at DESC LIMIT 1"
      )
      .get(tty) as Session | undefined;
    if (s) {
      db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?").run(
        new Date().toISOString(),
        s.session_id
      );
      return { id: s.session_id, name: s.friendly_name };
    }
  }

  throw new Error(
    "Session not registered. The session-start hook should have registered this session. " +
      "If not, call register_self with your session_id."
  );
}
