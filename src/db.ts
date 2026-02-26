import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Session, Message } from "./types.js";
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
  const now = new Date().toISOString();

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

  // Deactivate any other session that had this tty (tty was reassigned)
  if (opts.tty) {
    db.prepare(
      "UPDATE sessions SET is_active = 0 WHERE tty = ? AND session_id != ?"
    ).run(opts.tty, opts.session_id);
  }

  // Re-identification: if an active session exists with the same cwd and a dead
  // PID, this is likely the same project reconnecting after an IDE/terminal
  // restart. Transfer its friendly name so the user sees a consistent identity.
  let friendlyName: string | null = null;
  if (opts.cwd) {
    const predecessor = db
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
        `[db] Re-identified: transferring name "${friendlyName}" from ${predecessor.session_id} to ${opts.session_id}`
      );
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
): boolean {
  const db = getDb();
  try {
    db.prepare(
      "UPDATE sessions SET friendly_name = ? WHERE session_id = ?"
    ).run(newName, sessionId);
    return true;
  } catch {
    return false; // Unique constraint violation
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

export function sendMessage(
  fromName: string,
  toSession: string,
  content: string
): Message {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO messages (from_session, to_session, content, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(fromName, toSession, content, now);

  return db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(result.lastInsertRowid) as Message;
}

export function readMessages(
  sessionName: string,
  sessionId: string,
  unreadOnly: boolean = true
): Message[] {
  const db = getDb();
  const now = new Date().toISOString();

  let messages: Message[];
  if (unreadOnly) {
    messages = db
      .prepare(
        `SELECT * FROM messages
         WHERE (to_session = ? OR to_session = ? OR to_session = '*')
         AND read_at IS NULL
         ORDER BY created_at`
      )
      .all(sessionName, sessionId) as Message[];
  } else {
    messages = db
      .prepare(
        `SELECT * FROM messages
         WHERE (to_session = ? OR to_session = ? OR to_session = '*')
         ORDER BY created_at DESC LIMIT 50`
      )
      .all(sessionName, sessionId) as Message[];
  }

  // Mark as read
  if (messages.length > 0) {
    const ids = messages.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE messages SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`
    ).run(now, ...ids);
  }

  return messages;
}

export function getDbPath(): string {
  return DB_PATH;
}
