import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BRIDGES_DIR, BRIDGE_TIMEOUT } from "./config.js";
import { createLogger } from "./logger.js";
import type { BridgeRegistry } from "./types.js";

const log = createLogger("bridge");

const DEFAULT_BRIDGE_HOST = "127.0.0.1";

interface BridgeResponse {
  ok: boolean;
  error?: string;
  terminal?: string;
  method?: string;
}

/**
 * Discover all active bridge instances by reading registry files.
 * Cleans up stale entries whose PIDs are dead.
 */
function discoverBridges(): BridgeRegistry[] {
  try {
    fs.mkdirSync(BRIDGES_DIR, { recursive: true });
  } catch {
    // Expected: directory may already exist or parent path is read-only
  }

  let files: string[];
  try {
    files = fs.readdirSync(BRIDGES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    // Expected: directory may not exist yet (first run)
    return [];
  }

  const bridges: BridgeRegistry[] = [];
  for (const file of files) {
    const filePath = path.join(BRIDGES_DIR, file);
    try {
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as BridgeRegistry;

      // Remote bridges can't be PID-checked -- just trust them
      if (data.remote) {
        bridges.push(data);
      } else {
        // Local bridge: check if the process is still alive
        try {
          process.kill(data.pid, 0);
          bridges.push(data);
        } catch {
          // Expected: process exited, clean up its registry file
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Expected: file may have been removed by another process
          }
        }
      }
    } catch {
      // Expected: corrupt or malformed bridge registry file, remove it
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Expected: file may have been removed by another process
      }
    }
  }

  return bridges;
}

/**
 * Send a request to a single bridge instance.
 */
function sendToBridge(
  port: number,
  text: string,
  routing: { session_id?: string; pid?: number },
  host?: string
): Promise<BridgeResponse | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ ...routing, text });
    const req = http.request(
      {
        hostname: host || DEFAULT_BRIDGE_HOST,
        port,
        path: "/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: BRIDGE_TIMEOUT,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            // Expected: bridge returned non-JSON response
            resolve(null);
          }
        });
      }
    );

    req.on("error", (err: Error) => {
      log.warn("Request failed", { error: err.message });
      resolve(null);
    });
    req.on("timeout", () => {
      log.warn("Request timed out", { port });
      req.destroy();
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Push a message to a terminal via any available bridge instance.
 * Accepts session_id or pid for routing.
 * Tries each discovered bridge until one succeeds.
 */
export async function pushToTerminal(
  text: string,
  routing: { session_id?: string; pid?: number }
): Promise<BridgeResponse | null> {
  const bridges = discoverBridges();
  if (bridges.length === 0) {
    return null;
  }

  for (const bridge of bridges) {
    const result = await sendToBridge(bridge.port, text, routing, bridge.host);
    if (result?.ok) {
      return result;
    }
  }

  return { ok: false, error: `No bridge instance has a terminal for ${JSON.stringify(routing)}` };
}

/**
 * Check if any bridge is reachable.
 */
export function isBridgeAvailable(): boolean {
  return discoverBridges().length > 0;
}

/**
 * Notify the bridge on a specific IP about a session registration.
 * Only the bridge serving sessions from this IP gets notified.
 * No broadcasting -- direct routing by IP.
 */
export function notifyBridge(targetIp: string, session: {
  session_id: string;
  friendly_name: string;
  cwd?: string;
  pid?: number;
}): void {
  const bridges = discoverBridges();
  const payload = JSON.stringify({
    session_id: session.session_id,
    friendly_name: session.friendly_name,
    cwd: session.cwd || "",
    pid: session.pid || null,
  });

  // Normalize: local requests (127.0.0.1, ::1) match local bridges (no host or 127.0.0.1 or 0.0.0.0)
  const isLocal = targetIp === "127.0.0.1" || targetIp === "::1" || targetIp === "0.0.0.0";

  for (const bridge of bridges) {
    const bridgeIsLocal = !bridge.host || bridge.host === "127.0.0.1" || bridge.host === "0.0.0.0";
    const bridgeIp = bridge.host || "127.0.0.1";

    // Match: local session -> local bridges, remote session -> bridge on same IP
    const matches = isLocal ? bridgeIsLocal : bridgeIp === targetIp;
    if (!matches) continue;

    const req = http.request(
      {
        hostname: bridgeIp === "0.0.0.0" ? "127.0.0.1" : bridgeIp,
        port: bridge.port,
        path: "/notify",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 2000,
      },
      () => {} // fire and forget
    );
    req.on("error", (err: Error) => {
      log.warn("Notification failed", { port: bridge.port, error: err.message });
    });
    req.on("timeout", () => {
      log.warn("Notification timed out", { port: bridge.port });
      req.destroy();
    });
    req.write(payload);
    req.end();
  }
}

/**
 * Push a message to a specific IP's bridge.
 * Used for targeted delivery when we know the session's source IP.
 */
export async function pushToSessionBridge(
  targetIp: string,
  text: string,
  routing: { session_id?: string; pid?: number }
): Promise<BridgeResponse | null> {
  const bridges = discoverBridges();
  const isLocal = targetIp === "127.0.0.1" || targetIp === "::1" || targetIp === "0.0.0.0";

  for (const bridge of bridges) {
    const bridgeIsLocal = !bridge.host || bridge.host === "127.0.0.1" || bridge.host === "0.0.0.0";
    const bridgeIp = bridge.host || "127.0.0.1";
    const matches = isLocal ? bridgeIsLocal : bridgeIp === targetIp;
    if (!matches) continue;

    const result = await sendToBridge(bridge.port, text, routing,
      bridgeIp === "0.0.0.0" ? "127.0.0.1" : bridgeIp);
    if (result?.ok) return result;
  }

  // Fallback: try all bridges (in case source_ip isn't set yet)
  return pushToTerminal(text, routing);
}
