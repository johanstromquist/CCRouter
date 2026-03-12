import { createServer, IncomingMessage, ServerResponse } from "node:http";
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
import { pushToTerminal } from "./bridge.js";
import { scanLockFiles, isProcessAlive } from "./lock-scanner.js";
import type { RegisterRequest, Session } from "./types.js";

const PORT = 19919;
const POLL_INTERVAL = 30_000; // 30s -- PID alive checks
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutes

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
    tty: string;
  };
  if (!body.channel || !body.sender || !body.tty) {
    json(res, 400, { error: "channel, sender, and tty required" });
    return;
  }
  const acked = ackMessage(body.channel, body.sender, body.tty);
  json(res, 200, { ok: true, acked });
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
    // 1. Dead PID -- immediate cleanup
    if (session.pid && !isProcessAlive(session.pid)) {
      console.log(
        `[cleanup] Deactivating "${session.friendly_name}" -- PID ${session.pid} is dead`
      );
      markSessionInactive(session.session_id);
      continue;
    }

    // 2. Inactivity timeout -- no heartbeat for 60 minutes AND PID is dead
    if (session.last_seen_at) {
      const lastSeen = new Date(session.last_seen_at).getTime();
      if (now - lastSeen > INACTIVITY_TIMEOUT) {
        if (session.pid && !isProcessAlive(session.pid)) {
          console.log(
            `[cleanup] Deactivating "${session.friendly_name}" -- inactive for ${Math.round((now - lastSeen) / 60_000)} minutes and PID ${session.pid} is dead`
          );
          markSessionInactive(session.session_id);
        }
        continue;
      }
    }
  }
}

// --- Message delivery retry ---

async function retryUnackedMessages() {
  // Check for messages unacked after 30 seconds
  const unacked = getUnackedMessages(30);

  for (const pending of unacked) {
    if (pending.retry_count === 0) {
      // First retry: just send Enter (the original message may be stuck in buffer)
      console.log(
        `[retry] Nudging ${pending.target_name} (Enter) for message ${pending.message_id} in ${pending.channel}`
      );
      await pushToTerminal(pending.target_tty, "");
      incrementRetry(pending.id);
    } else if (pending.retry_count === 1) {
      // Second retry: send a follow-up question
      console.log(
        `[retry] Prodding ${pending.target_name} for message ${pending.message_id} in ${pending.channel}`
      );
      const nudge = `[${pending.channel}] ${pending.sender_name}: Did you receive my recent message?`;
      await pushToTerminal(pending.target_tty, nudge);
      incrementRetry(pending.id);
    } else {
      // Give up and notify sender
      console.log(
        `[retry] Delivery failed for message ${pending.message_id} to ${pending.target_name} -- notifying ${pending.sender_name}`
      );
      markAckFailed(pending.id);

      // Push failure notification to sender
      const sender = resolveSession(pending.sender_name);
      if (sender?.tty) {
        const notice = `[CCRouter] Message delivery to "${pending.target_name}" in ${pending.channel} was not acknowledged after retries. The agent may be unresponsive.`;
        await pushToTerminal(sender.tty, notice);
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
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (req.method === "POST" && url.pathname === "/register") {
      await handleRegister(req, res);
    } else if (req.method === "POST" && url.pathname === "/deregister") {
      await handleDeregister(req, res);
    } else if (req.method === "POST" && url.pathname === "/ack") {
      await handleAck(req, res);
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
    console.error("[http] Error:", err);
    json(res, 500, { error: "internal error" });
  }
});

// --- Start ---

function main() {
  // Initialize DB
  getDb();

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.log(`CCRouter daemon listening on http://127.0.0.1:${PORT}`);
  });

  // Periodic cleanup (30s)
  setInterval(() => {
    try {
      cleanupStaleSessions();
      cleanupChannelMemberships();
      syncLockFiles();
      cleanupOldAcks();
    } catch (err) {
      console.error("[poll] Error during cleanup:", err);
    }
  }, POLL_INTERVAL);

  // Message delivery retry (10s -- needs faster cadence than cleanup)
  setInterval(() => {
    retryUnackedMessages().catch((err) => {
      console.error("[retry] Error during retry loop:", err);
    });
  }, 10_000);

  // Run once at startup
  cleanupStaleSessions();

  console.log("CCRouter daemon started");
}

main();
