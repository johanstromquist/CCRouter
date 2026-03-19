import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import type { Session, Message, ChannelMember, ChannelInvite } from "./types.js";
import { resolveSessionName } from "./session.js";
import { CCROUTER_HOME, DB_PATH } from "./config.js";
import { runMigrations } from "./migration.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(CCROUTER_HOME, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  runMigrations(_db);

  return _db;
}

export function registerSession(opts: {
  session_id: string;
  pid?: number;
  tty?: string;
  cwd?: string;
  desired_name?: string;
  workspace_folders?: string[];
  ide_name?: string;
  lock_port?: number;
}): Session {
  const db = getDb();

  // Normalize Windows paths (backslash -> forward slash) so cwd matching
  // works regardless of which path separator the hook or CC uses.
  const normalizedCwd = opts.cwd?.replace(/\\/g, "/");

  const result = db.transaction(() => {
    const now = new Date().toISOString();

    // Check if there's already an active session on this tty.
    // If so, reuse it rather than creating a new one.
    if (opts.tty) {
      const ttySession = db
        .prepare(
          "SELECT * FROM sessions WHERE tty = ? AND is_active = 1 AND session_id != ?"
        )
        .get(opts.tty, opts.session_id) as Session | undefined;

      if (ttySession) {
        db.prepare(
          "UPDATE sessions SET last_seen_at = ?, pid = COALESCE(?, pid), cwd = COALESCE(?, cwd) WHERE session_id = ?"
        ).run(now, opts.pid ?? null, normalizedCwd ?? null, ttySession.session_id);
        return ttySession;
      }
    }

    // Check if session already exists (same session_id reconnecting)
    const existing = db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(opts.session_id) as Session | undefined;

    if (existing) {
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
        normalizedCwd ?? null,
        opts.workspace_folders ? JSON.stringify(opts.workspace_folders) : null,
        opts.ide_name ?? null,
        opts.lock_port ?? null,
        opts.session_id
      );
      return db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(opts.session_id) as Session;
    }

    // Delegate name resolution to session.ts
    const { name: friendlyName, isCustom: nameIsCustom } = resolveSessionName(db, {
      session_id: opts.session_id,
      tty: opts.tty,
      cwd: normalizedCwd,
      desired_name: opts.desired_name,
    });

    db.prepare(
      `INSERT INTO sessions (session_id, friendly_name, pid, tty, cwd, workspace_folders, ide_name, lock_port, registered_at, last_seen_at, is_active, name_custom)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      opts.session_id,
      friendlyName,
      opts.pid ?? null,
      opts.tty ?? null,
      normalizedCwd ?? null,
      opts.workspace_folders ? JSON.stringify(opts.workspace_folders) : null,
      opts.ide_name ?? null,
      opts.lock_port ?? null,
      now,
      now,
      nameIsCustom ? 1 : 0
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

  // If the name is held by an inactive session, delete it to free the name.
  // No grace period -- if you want the name and the old session is dead, take it.
  const inactiveTaken = db
    .prepare(
      "SELECT session_id, friendly_name FROM sessions WHERE friendly_name = ? AND is_active = 0 AND session_id != ?"
    )
    .get(newName, sessionId) as { session_id: string; friendly_name: string } | undefined;
  if (inactiveTaken) {
    // Transfer channel memberships from the dead session before deleting it
    db.prepare("UPDATE channel_members SET session_name = ? WHERE session_name = ?").run(
      newName, inactiveTaken.friendly_name
    );
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(inactiveTaken.session_id);
  }

  try {
    const old = db
      .prepare("SELECT friendly_name FROM sessions WHERE session_id = ?")
      .get(sessionId) as { friendly_name: string } | undefined;
    db.prepare(
      "UPDATE sessions SET friendly_name = ?, name_custom = 1 WHERE session_id = ?"
    ).run(newName, sessionId);
    if (old && old.friendly_name !== newName) {
      db.prepare("UPDATE channel_members SET session_name = ? WHERE session_name = ?").run(newName, old.friendly_name);
      db.prepare("UPDATE channel_invites SET from_session = ? WHERE from_session = ?").run(newName, old.friendly_name);
      db.prepare("UPDATE channel_invites SET to_session = ? WHERE to_session = ?").run(newName, old.friendly_name);
    }
    return true;
  } catch {
    // Expected: UNIQUE constraint violation when name is taken by a concurrent update
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

// --- Pending acks (message delivery tracking) ---

export interface PendingAck {
  id: number;
  message_id: number;
  channel: string;
  sender_name: string;
  target_name: string;
  target_tty: string | null;
  target_session_id: string | null;
  created_at: string;
  acked_at: string | null;
  retry_count: number;
  failed: number;
}

export function createPendingAck(
  messageId: number,
  channel: string,
  senderName: string,
  targetName: string,
  targetIdentifier: string,
  targetSessionId?: string
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO pending_acks (message_id, channel, sender_name, target_name, target_tty, target_session_id, created_at, retry_count, failed)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
  ).run(messageId, channel, senderName, targetName, targetIdentifier, targetSessionId || null, new Date().toISOString());
}

export function ackMessage(
  channel: string,
  senderName: string,
  opts: { targetTty?: string; targetSessionId?: string }
): boolean {
  const db = getDb();
  let pending: { id: number } | undefined;

  if (opts.targetTty) {
    // Mac: match by tty
    pending = db
      .prepare(
        `SELECT id FROM pending_acks
         WHERE channel = ? AND sender_name = ? AND target_tty = ?
           AND acked_at IS NULL AND failed = 0
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(channel, senderName, opts.targetTty) as { id: number } | undefined;
  }

  if (!pending && opts.targetSessionId) {
    // Windows/remote: match by session_id
    pending = db
      .prepare(
        `SELECT id FROM pending_acks
         WHERE channel = ? AND sender_name = ? AND target_session_id = ?
           AND acked_at IS NULL AND failed = 0
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(channel, senderName, opts.targetSessionId) as { id: number } | undefined;
  }

  if (!pending && opts.targetSessionId) {
    // Fallback: match by target_name (resolved from session_id)
    const session = getSessionById(opts.targetSessionId);
    if (session) {
      pending = db
        .prepare(
          `SELECT id FROM pending_acks
           WHERE channel = ? AND sender_name = ? AND target_name = ?
             AND acked_at IS NULL AND failed = 0
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(channel, senderName, session.friendly_name) as { id: number } | undefined;
    }
  }

  if (!pending) return false;

  db.prepare("UPDATE pending_acks SET acked_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    pending.id
  );
  return true;
}

export function getUnackedMessages(olderThanSeconds: number): PendingAck[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM pending_acks
       WHERE acked_at IS NULL AND failed = 0
         AND created_at < datetime('now', '-' || ? || ' seconds')
       ORDER BY created_at`
    )
    .all(olderThanSeconds) as PendingAck[];
}

export function incrementRetry(id: number): void {
  const db = getDb();
  db.prepare("UPDATE pending_acks SET retry_count = retry_count + 1 WHERE id = ?").run(id);
}

export function markAckFailed(id: number): void {
  const db = getDb();
  db.prepare("UPDATE pending_acks SET failed = 1 WHERE id = ?").run(id);
}

export function cleanupOldAcks(): void {
  const db = getDb();
  // Remove acked or failed entries older than 1 hour
  db.prepare(
    `DELETE FROM pending_acks
     WHERE (acked_at IS NOT NULL OR failed = 1)
       AND created_at < datetime('now', '-1 hour')`
  ).run();
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
