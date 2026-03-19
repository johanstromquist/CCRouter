import { join } from "node:path";

// ---------------------------------------------------------------------------
// Platform-aware home directory
// ---------------------------------------------------------------------------

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "/tmp";

// ---------------------------------------------------------------------------
// CCRouter directory structure
// ---------------------------------------------------------------------------

export const CCROUTER_HOME = process.env.CCROUTER_HOME || join(HOME_DIR, ".ccrouter");
export const DB_PATH = join(CCROUTER_HOME, "ccrouter.db");
export const BRIDGES_DIR = join(CCROUTER_HOME, "bridges");
export const SESSIONS_DIR = join(CCROUTER_HOME, "last-sessions");
export const DATA_DIR = join(CCROUTER_HOME, "data");

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const DAEMON_PORT = parseInt(process.env.CCROUTER_DAEMON_PORT || "19919", 10);
export const SSE_PORT = parseInt(process.env.CCROUTER_MCP_PORT || "19920", 10);
export const BIND_HOST = process.env.CCROUTER_BIND_HOST || "0.0.0.0";
/** Host for the SSE MCP server (default: "0.0.0.0"). Set via CCROUTER_MCP_HOST. */
export const MCP_HOST = process.env.CCROUTER_MCP_HOST || "0.0.0.0";
export const ADVERTISE_IP = process.env.CCROUTER_ADVERTISE_IP;
/** Log level for all CCRouter components (default: "info"). Set via LOG_LEVEL. */
export const LOG_LEVEL = (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") || "info";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export const POLL_INTERVAL = parseInt(
  process.env.CCROUTER_POLL_INTERVAL || "30000",
  10
);
export const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutes
export const REMOTE_HEARTBEAT_TIMEOUT = 10 * 60 * 1000; // 10 minutes
export const BRIDGE_TIMEOUT = 3000;
export const ACK_TIMEOUT_SECONDS = 30;
export const MAX_RETRIES = 2;
