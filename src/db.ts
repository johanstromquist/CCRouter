import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Session, Message, ChannelMember, ChannelInvite } from "./types.js";
import { generateName } from "./names.js";
import { isProcessAlive } from "./lock-scanner.js";

const DB_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".ccrouter"
);
const DB_PATH = join(DB_DIR, "ccrouter.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      friendly_name TEXT UNIQUE NOT NULL,
      pid INTEGER,
      tty TEXT,
      cwd TEXT,
      workspace_folders TEXT,
      ide_name TEXT,
      lock_port INTEGER,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_session TEXT NOT NULL,
      to_session TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_session);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);
  `);

  // Migration: add tty column if missing
  const cols = _db
    .prepare("PRAGMA table_info(sessions)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "tty")) {
    _db.exec("ALTER TABLE sessions ADD COLUMN tty TEXT");
  }

  // Migration: rename messages.to_session -> messages.channel
  const msgCols = _db
    .prepare("PRAGMA table_info(messages)")
    .all() as { name: string }[];
  if (msgCols.some((c) => c.name === "to_session") && !msgCols.some((c) => c.name === "channel")) {
    _db.exec("ALTER TABLE messages RENAME COLUMN to_session TO channel");
  }

  // Channel tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_name TEXT NOT NULL,
      session_name TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (channel_name, session_name)
    );

    CREATE TABLE IF NOT EXISTS channel_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_name TEXT NOT NULL,
      from_session TEXT NOT NULL,
      to_session TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_channel_members_session ON channel_members(session_name);
    CREATE INDEX IF NOT EXISTS idx_channel_invites_to ON channel_invites(to_session, status);
  `);

  return _db;
}

export function registerSession(opts: {
  session_id: string;
  pid?: number;
  tty?: string;
  cwd?: string;
  workspace_folders?: string[];
  ide_name?: string;
  lock_port?: number;
}): Session {
  const db = getDb();

  // Wrap in IMMEDIATE transaction to serialize concurrent registrations.
  // Without this, two hooks firing simultaneously for the same tty can both
  // read "no existing session" and both insert, leaving duplicates.
  const result = db.transaction(() => {
    const now = new Date().toISOString();

    // Check if there's already an active session on this tty.
    // If so, reuse it rather than creating a new one -- this handles the
    // case where hooks fire with different session_ids for the same terminal.
    if (opts.tty) {
      const ttySession = db
        .prepare(
          "SELECT * FROM sessions WHERE tty = ? AND is_active = 1 AND session_id != ?"
        )
        .get(opts.tty, opts.session_id) as Session | undefined;

      if (ttySession) {
        // Same tty, different session_id -- reuse the existing session
        db.prepare(
          "UPDATE sessions SET last_seen_at = ?, pid = COALESCE(?, pid), cwd = COALESCE(?, cwd) WHERE session_id = ?"
        ).run(new Date().toISOString(), opts.pid ?? null, opts.cwd ?? null, ttySession.session_id);
        return ttySession;
      }
    }

    // Check if session already exists
    const existing = db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(opts.session_id) as Session | undefined;

    if (existing) {
      // Reactivate
      db.prepare(
        `UPDATE sessions SET is_active = 1, last_seen_at = ?, pid = COALESCE(?, pid),
         tty = COALESCE(?, tty), cwd = COALESCE(?, cwd),
         workspace_folders = COALESCE(?, workspace_folders),
         ide_name = COALESCE(?, ide_name), lock_port = COALESCE(?, lock_port)
         WHERE session_id = ?`
      ).run(
        now,
        opts.pid ?? null,
        opts.tty ?? null,
        opts.cwd ?? null,
        opts.workspace_folders ? JSON.stringify(opts.workspace_folders) : null,
        opts.ide_name ?? null,
        opts.lock_port ?? null,
        opts.session_id
      );
      return db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(opts.session_id) as Session;
    }

    // Re-identification: if a session exists with the same cwd (active with dead
    // PID, or recently inactive), this is likely the same project reconnecting
    // after a restart. Transfer its friendly name and channel memberships.
    let friendlyName: string | null = null;
    if (opts.cwd) {
      // First try active sessions with dead PIDs
      let predecessor = db
        .prepare(
          `SELECT * FROM sessions
           WHERE cwd = ? AND is_active = 1 AND session_id != ?
           ORDER BY last_seen_at DESC LIMIT 1`
        )
        .get(opts.cwd, opts.session_id) as Session | undefined;

      if (predecessor && predecessor.pid && !isProcessAlive(predecessor.pid)) {
        friendlyName = predecessor.friendly_name;
        db.prepare(
          "UPDATE sessions SET is_active = 0, friendly_name = friendly_name || '-old' WHERE session_id = ?"
        ).run(predecessor.session_id);
        console.log(
          `[db] Re-identified (active predecessor): transferring name "${friendlyName}" from ${predecessor.session_id} to ${opts.session_id}`
        );
      }

      // If no active predecessor, check recently inactive sessions (within 24h)
      if (!friendlyName) {
        predecessor = db
          .prepare(
            `SELECT * FROM sessions
             WHERE cwd = ? AND is_active = 0 AND session_id != ?
               AND last_seen_at > datetime('now', '-24 hours')
               AND friendly_name NOT LIKE '%-old'
             ORDER BY last_seen_at DESC LIMIT 1`
          )
          .get(opts.cwd, opts.session_id) as Session | undefined;

        if (predecessor) {
          friendlyName = predecessor.friendly_name;
          db.prepare(
            "UPDATE sessions SET friendly_name = friendly_name || '-old' WHERE session_id = ?"
          ).run(predecessor.session_id);
          console.log(
            `[db] Re-identified (inactive predecessor): transferring name "${friendlyName}" from ${predecessor.session_id} to ${opts.session_id}`
          );
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

    db.prepare(
      `INSERT INTO sessions (session_id, friendly_name, pid, tty, cwd, workspace_folders, ide_name, lock_port, registered_at, last_seen_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      opts.session_id,
      friendlyName,
      opts.pid ?? null,
      opts.tty ?? null,
      opts.cwd ?? null,
      opts.workspace_folders ? JSON.stringify(opts.workspace_folders) : null,
      opts.ide_name ?? null,
      opts.lock_port ?? null,
      now,
      now
    );

    return db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(opts.session_id) as Session;
  }).immediate();

  return result;
}

export function deregisterSession(sessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE sessions SET is_active = 0 WHERE session_id = ?").run(
    sessionId
  );
}

export function getActiveSessions(): Session[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM sessions WHERE is_active = 1 ORDER BY registered_at")
    .all() as Session[];
}

export function getSessionById(sessionId: string): Session | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as Session | undefined;
}

export function getSessionByName(name: string): Session | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM sessions WHERE friendly_name = ? AND is_active = 1")
    .get(name) as Session | undefined;
}

export function resolveSession(nameOrId: string): Session | undefined {
  return getSessionByName(nameOrId) || getSessionById(nameOrId);
}

export function updateSessionName(
  sessionId: string,
  newName: string
): string | true {
  const db = getDb();

  // Check if the name is taken by another active session
  const activeTaken = db
    .prepare(
      "SELECT session_id FROM sessions WHERE friendly_name = ? AND is_active = 1 AND session_id != ?"
    )
    .get(newName, sessionId) as { session_id: string } | undefined;
  if (activeTaken) {
    return "taken";
  }

  // Check if the name belongs to a recently inactive session (24h grace period)
  const inactiveTaken = db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE friendly_name = ? AND is_active = 0 AND session_id != ?
         AND last_seen_at > datetime('now', '-24 hours')
         AND friendly_name NOT LIKE '%-old'`
    )
    .get(newName, sessionId) as { session_id: string } | undefined;
  if (inactiveTaken) {
    return "reserved";
  }

  try {
    const old = db
      .prepare("SELECT friendly_name FROM sessions WHERE session_id = ?")
      .get(sessionId) as { friendly_name: string } | undefined;
    db.prepare(
      "UPDATE sessions SET friendly_name = ? WHERE session_id = ?"
    ).run(newName, sessionId);
    if (old) {
      db.prepare("UPDATE channel_members SET session_name = ? WHERE session_name = ?").run(newName, old.friendly_name);
      db.prepare("UPDATE channel_invites SET from_session = ? WHERE from_session = ?").run(newName, old.friendly_name);
      db.prepare("UPDATE channel_invites SET to_session = ? WHERE to_session = ?").run(newName, old.friendly_name);
    }
    return true;
  } catch {
    return "taken";
  }
}

export function touchSession(sessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?").run(
    new Date().toISOString(),
    sessionId
  );
}

export function markSessionInactive(sessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE sessions SET is_active = 0 WHERE session_id = ?").run(
    sessionId
  );
}

// --- Channel membership ---

export function joinChannel(channelName: string, sessionName: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO channel_members (channel_name, session_name, joined_at) VALUES (?, ?, ?)"
  ).run(channelName, sessionName, now);
}

export function leaveChannel(channelName: string, sessionName: string): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM channel_members WHERE channel_name = ? AND session_name = ?"
  ).run(channelName, sessionName);
}

export function getChannelMembers(channelName: string): ChannelMember[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM channel_members WHERE channel_name = ?")
    .all(channelName) as ChannelMember[];
}

export function getChannelsForSession(sessionName: string): ChannelMember[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM channel_members WHERE session_name = ?")
    .all(sessionName) as ChannelMember[];
}

export function isChannelMember(channelName: string, sessionName: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM channel_members WHERE channel_name = ? AND session_name = ?")
    .get(channelName, sessionName);
  return !!row;
}

// --- Channel invites ---

export function createInvite(
  channelName: string,
  fromSession: string,
  toSession: string
): ChannelInvite {
  const db = getDb();
  const now = new Date().toISOString();

  // Avoid duplicate pending invites
  const existing = db
    .prepare(
      "SELECT * FROM channel_invites WHERE channel_name = ? AND to_session = ? AND status = 'pending'"
    )
    .get(channelName, toSession) as ChannelInvite | undefined;
  if (existing) return existing;

  const result = db
    .prepare(
      "INSERT INTO channel_invites (channel_name, from_session, to_session, created_at, status) VALUES (?, ?, ?, ?, 'pending')"
    )
    .run(channelName, fromSession, toSession, now);

  return db
    .prepare("SELECT * FROM channel_invites WHERE id = ?")
    .get(result.lastInsertRowid) as ChannelInvite;
}

export function getPendingInvites(sessionName: string): ChannelInvite[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM channel_invites WHERE to_session = ? AND status = 'pending' ORDER BY created_at"
    )
    .all(sessionName) as ChannelInvite[];
}

export function getInvite(channelName: string, toSession: string): ChannelInvite | undefined {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM channel_invites WHERE channel_name = ? AND to_session = ? AND status = 'pending'"
    )
    .get(channelName, toSession) as ChannelInvite | undefined;
}

export function acceptInvite(channelName: string, sessionName: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE channel_invites SET status = 'accepted' WHERE channel_name = ? AND to_session = ? AND status = 'pending'"
    )
    .run(channelName, sessionName);
  return result.changes > 0;
}

export function declineInvite(channelName: string, sessionName: string): boolean {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE channel_invites SET status = 'declined' WHERE channel_name = ? AND to_session = ? AND status = 'pending'"
    )
    .run(channelName, sessionName);
  return result.changes > 0;
}

// --- Channel messages ---

export function sendChannelMessage(
  fromName: string,
  channel: string,
  content: string
): Message {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO messages (from_session, channel, content, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(fromName, channel, content, now);

  return db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(result.lastInsertRowid) as Message;
}

export function readChannelMessages(
  sessionName: string,
  channels: string[],
  unreadOnly: boolean = true
): Message[] {
  const db = getDb();
  const now = new Date().toISOString();
  if (channels.length === 0) return [];

  const placeholders = channels.map(() => "?").join(",");
  let messages: Message[];
  if (unreadOnly) {
    messages = db
      .prepare(
        `SELECT * FROM messages
         WHERE channel IN (${placeholders})
         AND from_session != ?
         AND read_at IS NULL
         ORDER BY created_at`
      )
      .all(...channels, sessionName) as Message[];
  } else {
    messages = db
      .prepare(
        `SELECT * FROM messages
         WHERE channel IN (${placeholders})
         AND from_session != ?
         ORDER BY created_at DESC LIMIT 50`
      )
      .all(...channels, sessionName) as Message[];
  }

  // Mark as read
  if (messages.length > 0) {
    const ids = messages.map((m) => m.id);
    const idPlaceholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE messages SET read_at = ? WHERE id IN (${idPlaceholders}) AND read_at IS NULL`
    ).run(now, ...ids);
  }

  return messages;
}

// --- Cleanup ---

export function cleanupChannelMemberships(): void {
  const db = getDb();
  // Only remove memberships for sessions that have been inactive for over 24 hours.
  // This prevents memberships from being lost during brief session restarts.
  db.prepare(`
    DELETE FROM channel_members
    WHERE session_name NOT IN (
      SELECT friendly_name FROM sessions WHERE is_active = 1
    )
    AND session_name NOT IN (
      SELECT friendly_name FROM sessions
      WHERE is_active = 0
        AND last_seen_at > datetime('now', '-24 hours')
    )
  `).run();
}

export function getDbPath(): string {
  return DB_PATH;
}
