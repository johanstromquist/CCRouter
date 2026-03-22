import type Database from "better-sqlite3";

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          friendly_name TEXT UNIQUE NOT NULL,
          pid INTEGER,
          cwd TEXT,
          workspace_folders TEXT,
          ide_name TEXT,
          lock_port INTEGER,
          registered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          is_active INTEGER DEFAULT 1,
          name_custom INTEGER DEFAULT 0,
          source_ip TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_session TEXT NOT NULL,
          channel TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          read_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);
        CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(channel);
      `);
    },
  },
  {
    version: 2,
    description: "Add channels and acks",
    up: (db) => {
      db.exec(`
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

        CREATE TABLE IF NOT EXISTS pending_acks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL,
          channel TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          target_name TEXT NOT NULL,
          target_session_id TEXT,
          created_at TEXT NOT NULL,
          acked_at TEXT,
          retry_count INTEGER DEFAULT 0,
          failed INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_channel_members_session ON channel_members(session_name);
        CREATE INDEX IF NOT EXISTS idx_channel_invites_to ON channel_invites(to_session, status);
        CREATE INDEX IF NOT EXISTS idx_pending_acks_unacked ON pending_acks(acked_at, failed, created_at);
      `);
    },
  },
  {
    version: 3,
    description: "Add terminal_pid column to sessions",
    up: (db) => {
      db.exec(`ALTER TABLE sessions ADD COLUMN terminal_pid INTEGER`);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`
  );

  const row = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null };
  const currentVersion = row?.v ?? 0;

  // Existing DB without schema_version entries: detect state and stamp version
  if (currentVersion === 0) {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = new Set(tables.map((t) => t.name));

    if (tableNames.has("sessions")) {
      // DB already has tables from before the migration system.
      // All existing DBs have been through the ad-hoc migrations,
      // so stamp them at the latest version.
      const latestVersion = migrations[migrations.length - 1].version;
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
        latestVersion
      );
      console.log(
        `[migration] Existing DB detected, stamped at v${latestVersion}`
      );
      return;
    }
  }

  // Apply pending migrations in order
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
          migration.version
        );
      })();
      console.log(
        `[migration] Applied v${migration.version}: ${migration.description}`
      );
    }
  }
}
