import { createServer, IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  registerSession,
  deregisterSession,
  getActiveSessions,
  getSessionById,
  markSessionInactive,
  touchSession,
  getDb,
  cleanupChannelMemberships,
  ackMessage,
  getUnackedMessages,
  incrementRetry,
  markAckFailed,
  cleanupOldAcks,
  resolveSession,
} from "./db.js";
import { pushToTerminal, pushToSessionBridge, notifyBridge, normalizeIp } from "./bridge.js";
import { scanLockFiles } from "./lock-scanner.js";
import { createLogger } from "./logger.js";
import {
  DAEMON_PORT,
  POLL_INTERVAL,
  BRIDGE_HEARTBEAT_TIMEOUT,
  BIND_HOST,
  ACK_TIMEOUT_SECONDS,
  BRIDGES_DIR,
} from "./config.js";
import type { RegisterRequest, Session } from "./types.js";

const log = createLogger("daemon");

// --- HTTP helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- Route handlers ---

async function handleRegister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as RegisterRequest;
  if (!body.session_id) {
    json(res, 400, { error: "session_id required" });
    return;
  }

  const sourceIp = normalizeIp((req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, ""));

  const session = registerSession(body);

  // Store source IP for push routing
  const db = getDb();
  db.prepare("UPDATE sessions SET source_ip = ? WHERE session_id = ?")
    .run(sourceIp, session.session_id);

  // Notify only the bridge on the same IP (not all bridges)
  notifyBridge(sourceIp, {
    session_id: session.session_id,
    friendly_name: session.friendly_name,
    cwd: session.cwd || body.cwd,
    pid: session.pid || body.pid,
    terminal_pid: session.terminal_pid || body.terminal_pid,
  });

  json(res, 200, {
    friendly_name: session.friendly_name,
    session_id: session.session_id,
  });
}

async function handleDeregister(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as { session_id: string };
  if (!body.session_id) {
    json(res, 400, { error: "session_id required" });
    return;
  }
  deregisterSession(body.session_id);
  json(res, 200, { ok: true });
}

function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  const sessions = getActiveSessions();
  json(res, 200, {
    status: "ok",
    active_sessions: sessions.length,
    uptime: process.uptime(),
  });
}

async function handleAck(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as {
    channel: string;
    sender: string;
    session_id?: string;
  };
  if (!body.channel || !body.sender || !body.session_id) {
    json(res, 400, { error: "channel, sender, and session_id required" });
    return;
  }
  const acked = ackMessage(body.channel, body.sender, body.session_id);
  json(res, 200, { ok: true, acked });
}

async function handleRegisterBridge(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req)) as {
    port: number;
    host: string;
    pid?: number;
  };
  if (!body.port || !body.host) {
    json(res, 400, { error: "port and host required" });
    return;
  }

  const sourceIp = normalizeIp((req.socket.remoteAddress || "127.0.0.1").replace(/^::ffff:/, ""));

  fs.mkdirSync(BRIDGES_DIR, { recursive: true });

  const registryFile = path.join(BRIDGES_DIR, `${sourceIp}-${body.port}.json`);
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      port: body.port,
      host: sourceIp,
      pid: body.pid || 0,
      started: Date.now(),
    })
  );

  // Bridge heartbeat keeps sessions alive
  const db = getDb();
  db.prepare(
    "UPDATE sessions SET last_seen_at = ? WHERE source_ip = ? AND is_active = 1"
  ).run(new Date().toISOString(), sourceIp);

  json(res, 200, { ok: true, registered: `${sourceIp}:${body.port}` });
}

function handleSessionInfo(sessionId: string, res: ServerResponse) {
  const session = getSessionById(sessionId);
  if (!session) {
    json(res, 404, { error: "session not found" });
    return;
  }
  json(res, 200, session);
}

// --- Stale session cleanup ---

function cleanupStaleSessions() {
  const sessions = getActiveSessions();
  const now = Date.now();

  for (const session of sessions) {
    const lastSeen = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
    if (lastSeen && now - lastSeen > BRIDGE_HEARTBEAT_TIMEOUT) {
      const idleMinutes = Math.round((now - lastSeen) / 60_000);
      log.info(`Deactivating "${session.friendly_name}" -- no heartbeat for ${idleMinutes} minutes`);
      markSessionInactive(session.session_id);
    }
  }
}

// --- Message delivery retry ---

async function retryUnackedMessages() {
  // Check for messages unacked after the configured timeout
  const unacked = getUnackedMessages(ACK_TIMEOUT_SECONDS);

  for (const pending of unacked) {
    const targetSession = resolveSession(pending.target_name);
    if (!targetSession) continue;

    const push = targetSession.source_ip
      ? (text: string) => pushToSessionBridge(targetSession.source_ip!, text, {
          session_id: targetSession.session_id,
          pid: targetSession.pid || undefined,
        })
      : (text: string) => pushToTerminal(text, {
          session_id: targetSession.session_id,
          pid: targetSession.pid || undefined,
        });

    if (pending.retry_count === 0) {
      log.info(`Nudging ${pending.target_name} (Enter) for message ${pending.message_id} in ${pending.channel}`);
      await push("");
      incrementRetry(pending.id);
    } else if (pending.retry_count === 1) {
      log.info(`Prodding ${pending.target_name} for message ${pending.message_id} in ${pending.channel}`);
      await push(`[${pending.channel}] ${pending.sender_name}: Did you receive my recent message?`);
      incrementRetry(pending.id);
    } else {
      log.warn(`Delivery failed for message ${pending.message_id} to ${pending.target_name} -- notifying ${pending.sender_name}`);
      markAckFailed(pending.id);

      const sender = resolveSession(pending.sender_name);
      if (sender) {
        const notice = `[CCRouter] Message delivery to "${pending.target_name}" in ${pending.channel} was not acknowledged after retries. The agent may be unresponsive.`;
        if (sender.source_ip) {
          await pushToSessionBridge(sender.source_ip, notice, {
            session_id: sender.session_id,
            pid: sender.pid || undefined,
          });
        } else {
          await pushToTerminal(notice, {
            session_id: sender.session_id,
            pid: sender.pid || undefined,
          });
        }
      }
    }
  }
}

// --- Cross-reference lock files with sessions ---

function syncLockFiles() {
  const locks = scanLockFiles();

  // Touch sessions that have active lock files
  for (const [, info] of locks) {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      if (session.pid === info.pid || session.lock_port === info.port) {
        touchSession(session.session_id);
      }
    }
  }
}

// --- HTTP Server ---

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${DAEMON_PORT}`);

    if (req.method === "POST" && url.pathname === "/register") {
      await handleRegister(req, res);
    } else if (req.method === "POST" && url.pathname === "/deregister") {
      await handleDeregister(req, res);
    } else if (req.method === "POST" && url.pathname === "/ack") {
      await handleAck(req, res);
    } else if (req.method === "POST" && url.pathname === "/register-bridge") {
      await handleRegisterBridge(req, res);
    } else if (
      req.method === "GET" &&
      url.pathname.startsWith("/session-by-pid/")
    ) {
      const pid = parseInt(url.pathname.slice("/session-by-pid/".length), 10);
      if (!pid) {
        json(res, 400, { error: "invalid pid" });
      } else {
        const db = getDb();
        const session = db
          .prepare("SELECT * FROM sessions WHERE pid = ? AND is_active = 1 ORDER BY last_seen_at DESC LIMIT 1")
          .get(pid) as Session | undefined;
        if (session) {
          json(res, 200, session);
        } else {
          json(res, 404, { error: "no active session for pid" });
        }
      }
    } else if (req.method === "GET" && url.pathname === "/health") {
      handleHealth(req, res);
    } else if (
      req.method === "GET" &&
      url.pathname.startsWith("/session/")
    ) {
      const sessionId = url.pathname.slice("/session/".length);
      handleSessionInfo(sessionId, res);
    } else {
      json(res, 404, { error: "not found" });
    }
  } catch (err) {
    log.error("HTTP error", { error: String(err) });
    json(res, 500, { error: "internal error" });
  }
});

// --- Start ---

function main() {
  // Initialize DB
  getDb();

  httpServer.listen(DAEMON_PORT, BIND_HOST, () => {
    log.info(`Daemon listening on http://${BIND_HOST}:${DAEMON_PORT}`);
  });

  // Periodic cleanup
  setInterval(() => {
    try {
      cleanupStaleSessions();
      cleanupChannelMemberships();
      syncLockFiles();
      cleanupOldAcks();
    } catch (err) {
      log.error("Error during cleanup", { error: String(err) });
    }
  }, POLL_INTERVAL);

  // Message delivery retry (10s -- needs faster cadence than cleanup)
  setInterval(() => {
    retryUnackedMessages().catch((err) => {
      log.error("Error during retry loop", { error: String(err) });
    });
  }, 10_000);

  // Run once at startup
  cleanupStaleSessions();

  log.info("CCRouter daemon started");
}

main();
