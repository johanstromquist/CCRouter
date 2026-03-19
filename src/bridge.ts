import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const BRIDGES_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".ccrouter",
  "bridges"
);

interface BridgeResponse {
  ok: boolean;
  error?: string;
  terminal?: string;
  tty?: string;
  method?: string;
}

interface BridgeRegistry {
  port: number;
  pid: number;
  host?: string;
  started: number;
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
      if ((data as any).remote) {
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
  routing: { tty?: string; session_id?: string; pid?: number },
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
        timeout: 3000,
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
      console.error("[bridge] request failed:", err.message);
      resolve(null);
    });
    req.on("timeout", () => {
      console.error("[bridge] request timed out to port", port);
      req.destroy();
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Push a message to a terminal via any available bridge instance.
 * Accepts tty (Mac), session_id, or pid for routing.
 * Tries each discovered bridge until one succeeds.
 */
export async function pushToTerminal(
  text: string,
  routing: { tty?: string; session_id?: string; pid?: number }
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
 * Notify all bridge instances about a session registration or rename.
 * This allows the Cursor extension to persist session->tty mappings
 * for crash recovery (claude-r).
 */
export function notifyBridges(session: {
  tty?: string;
  session_id: string;
  friendly_name: string;
  cwd?: string;
  pid?: number;
}): void {
  const bridges = discoverBridges();
  const payload = JSON.stringify({
    tty: session.tty || null,
    session_id: session.session_id,
    friendly_name: session.friendly_name,
    cwd: session.cwd || "",
    pid: session.pid || null,
  });

  for (const bridge of bridges) {
    const req = http.request(
      {
        hostname: bridge.host || DEFAULT_BRIDGE_HOST,
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
      console.error("[bridge] notification failed to port", bridge.port + ":", err.message);
    });
    req.on("timeout", () => {
      console.error("[bridge] notification timed out to port", bridge.port);
      req.destroy();
    });
    req.write(payload);
    req.end();
  }
}
