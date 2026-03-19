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
import { pushToTerminal, notifyBridges } from "./bridge.js";
import { scanLockFiles, isProcessAlive } from "./lock-scanner.js";
import { createLogger } from "./logger.js";
import {
  DAEMON_PORT,
  POLL_INTERVAL,
  INACTIVITY_TIMEOUT,
  REMOTE_HEARTBEAT_TIMEOUT,
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
  const session = registerSession(body);

  // Notify bridges so they can persist the session mapping and build terminal maps
  notifyBridges({
    tty: session.tty || body.tty,
    session_id: session.session_id,
    friendly_name: session.friendly_name,
    cwd: session.cwd || body.cwd,
    pid: session.pid || body.pid,
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
    tty?: string;
    session_id?: string;
  };
  if (!body.channel || !body.sender || (!body.tty && !body.session_id)) {
    json(res, 400, { error: "channel, sender, and (tty or session_id) required" });
    return;
  }
  const acked = ackMessage(body.channel, body.sender, {
    targetTty: body.tty,
    targetSessionId: body.session_id,
  });
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

  // Write a bridge registry file so bridge.ts can discover this remote bridge
  fs.mkdirSync(BRIDGES_DIR, { recursive: true });

  // Clean up old bridge files for this host (port may have changed on restart)
  try {
    const files = fs.readdirSync(BRIDGES_DIR).filter((f: string) => f.startsWith(`remote-${body.host}-`));
    for (const f of files) {
      try { fs.unlinkSync(path.join(BRIDGES_DIR, f)); } catch {}
    }
  } catch {}

  const registryFile = path.join(BRIDGES_DIR, `remote-${body.host}-${body.port}.json`);
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      port: body.port,
      host: body.host,
      pid: body.pid || 0,
      remote: true,
      started: Date.now(),
    })
  );

  log.info(`Remote bridge registered: ${body.host}:${body.port}`);
  json(res, 200, { ok: true, registered: `${body.host}:${body.port}` });
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
    const isRemote = !session.tty; // No tty = remote/Windows session
    const lastSeen = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
    const idleMinutes = Math.round((now - lastSeen) / 60_000);

    if (isRemote) {
      // Remote sessions: can't PID-check (PID is from a different machine).
      // Use heartbeat timeout only.
      if (lastSeen && now - lastSeen > REMOTE_HEARTBEAT_TIMEOUT) {
        log.info(`Deactivating remote session "${session.friendly_name}" -- no heartbeat for ${idleMinutes} minutes`);
        markSessionInactive(session.session_id);
      }
    } else {
      // Local sessions: PID check is reliable (same machine).
      if (session.pid && !isProcessAlive(session.pid)) {
        log.info(`Deactivating "${session.friendly_name}" -- PID ${session.pid} is dead`);
        markSessionInactive(session.session_id);
        continue;
      }

      // Inactivity timeout for local sessions with dead PIDs
      if (lastSeen && now - lastSeen > INACTIVITY_TIMEOUT) {
        if (session.pid && !isProcessAlive(session.pid)) {
          log.info(`Deactivating "${session.friendly_name}" -- inactive for ${idleMinutes} minutes and PID ${session.pid} is dead`);
          markSessionInactive(session.session_id);
        }
      }
    }
  }
}

// --- Message delivery retry ---

async function retryUnackedMessages() {
  // Check for messages unacked after the configured timeout
  const unacked = getUnackedMessages(ACK_TIMEOUT_SECONDS);

  for (const pending of unacked) {
    // Resolve target session for routing info
    const targetSession = resolveSession(pending.target_name);
    const routing = {
      tty: pending.target_tty || undefined,
      session_id: targetSession?.session_id,
      pid: targetSession?.pid || undefined,
    };

    if (pending.retry_count === 0) {
      log.info(`Nudging ${pending.target_name} (Enter) for message ${pending.message_id} in ${pending.channel}`);
      await pushToTerminal("", routing);
      incrementRetry(pending.id);
    } else if (pending.retry_count === 1) {
      log.info(`Prodding ${pending.target_name} for message ${pending.message_id} in ${pending.channel}`);
      const nudge = `[${pending.channel}] ${pending.sender_name}: Did you receive my recent message?`;
      await pushToTerminal(nudge, routing);
      incrementRetry(pending.id);
    } else {
      log.warn(`Delivery failed for message ${pending.message_id} to ${pending.target_name} -- notifying ${pending.sender_name}`);
      markAckFailed(pending.id);

      const sender = resolveSession(pending.sender_name);
      if (sender) {
        const notice = `[CCRouter] Message delivery to "${pending.target_name}" in ${pending.channel} was not acknowledged after retries. The agent may be unresponsive.`;
        await pushToTerminal(notice, {
          tty: sender.tty || undefined,
          session_id: sender.session_id,
          pid: sender.pid || undefined,
        });
      }
    }
  }
}

// --- Cross-reference lock files with sessions ---

function syncLockFiles() {
  const locks = scanLockFiles();

  // Touch sessions that have active lock files
  for (const [_key, info] of locks) {
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
