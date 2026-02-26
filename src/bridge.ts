import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const BRIDGE_HOST = "127.0.0.1";
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
  started: number;
}

/**
 * Discover all active bridge instances by reading registry files.
 * Cleans up stale entries whose PIDs are dead.
 */
function discoverBridges(): BridgeRegistry[] {
  try {
    fs.mkdirSync(BRIDGES_DIR, { recursive: true });
  } catch {}

  let files: string[];
  try {
    files = fs.readdirSync(BRIDGES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const bridges: BridgeRegistry[] = [];
  for (const file of files) {
    const filePath = path.join(BRIDGES_DIR, file);
    try {
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as BridgeRegistry;

      // Check if the process is still alive
      try {
        process.kill(data.pid, 0);
        bridges.push(data);
      } catch {
        // Dead process, clean up registry file
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    } catch {
      // Corrupt file, remove it
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  }

  return bridges;
}

/**
 * Send a request to a single bridge instance.
 */
function sendToBridge(
  port: number,
  tty: string,
  text: string
): Promise<BridgeResponse | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ tty, text });
    const req = http.request(
      {
        hostname: BRIDGE_HOST,
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
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
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
 */
export async function pushToTerminal(
  tty: string,
  text: string
): Promise<BridgeResponse | null> {
  const bridges = discoverBridges();
  if (bridges.length === 0) {
    return null;
  }

  for (const bridge of bridges) {
    const result = await sendToBridge(bridge.port, tty, text);
    if (result?.ok) {
      return result;
    }
    // "not found" means this bridge doesn't have the terminal -- try next
    // null or other errors mean bridge is broken -- also try next
  }

  // No bridge had the terminal
  return { ok: false, error: `No bridge instance has a terminal for tty ${tty}` };
}

/**
 * Check if any bridge is reachable.
 */
export function isBridgeAvailable(): boolean {
  return discoverBridges().length > 0;
}
