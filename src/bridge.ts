import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BRIDGES_DIR, BRIDGE_TIMEOUT } from "./config.js";
import { createLogger } from "./logger.js";
import type { BridgeRegistry } from "./types.js";

const log = createLogger("bridge");

/** Normalize loopback variants to a single canonical IP. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip || ip === "::1" || ip === "0.0.0.0" || ip === "127.0.0.1") return "127.0.0.1";
  return ip.replace(/^::ffff:/, "");
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
  terminal?: string;
  method?: string;
}

/**
 * Discover all active bridge instances by reading registry files.
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
      data.host = normalizeIp(data.host);
      bridges.push(data);
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
  host: string
): Promise<BridgeResponse | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ ...routing, text });
    const req = http.request(
      {
        hostname: host,
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
 * Tries each discovered bridge until one succeeds.
 * Prefers session_map matches over other methods.
 */
export async function pushToTerminal(
  text: string,
  routing: { session_id?: string; pid?: number }
): Promise<BridgeResponse | null> {
  const bridges = discoverBridges();
  if (bridges.length === 0) return null;

  for (const bridge of bridges) {
    const result = await sendToBridge(bridge.port, text, routing, bridge.host);
    if (result?.ok && result.method === "session_map") return result;
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
 * Notify bridges on a specific IP about a session registration.
 */
export function notifyBridge(targetIp: string, session: {
  session_id: string;
  friendly_name: string;
  cwd?: string;
  pid?: number;
  terminal_pid?: number;
}): void {
  const bridges = discoverBridges();
  const normalizedTarget = normalizeIp(targetIp);
  const payload = JSON.stringify({
    session_id: session.session_id,
    friendly_name: session.friendly_name,
    cwd: session.cwd || "",
    pid: session.pid || null,
    terminal_pid: session.terminal_pid || null,
  });

  for (const bridge of bridges) {
    if (bridge.host !== normalizedTarget) continue;

    const req = http.request(
      {
        hostname: bridge.host,
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
 * Push a message to a session's bridge by IP.
 * Prefers session_map matches, falls back to any successful delivery.
 */
export async function pushToSessionBridge(
  targetIp: string,
  text: string,
  routing: { session_id?: string; pid?: number }
): Promise<BridgeResponse | null> {
  const bridges = discoverBridges();
  const normalizedTarget = normalizeIp(targetIp);
  for (const bridge of bridges) {
    if (bridge.host !== normalizedTarget) continue;

    const result = await sendToBridge(bridge.port, text, routing, bridge.host);
    if (result?.ok && result.method === "session_map") return result;
  }

  // Fallback: try all bridges (in case source_ip isn't set yet)
  return pushToTerminal(text, routing);
}
