import { join } from "node:path";
import { readFileSync } from "node:fs";

export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

export function getCcrouterDir(): string {
  return join(getHomeDir(), ".ccrouter");
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Read the daemon URL from ~/.ccrouter/config.json with a localhost fallback.
 */
export function getDaemonUrl(): string {
  const configPath = join(getCcrouterDir(), "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (config.daemonUrl) return config.daemonUrl;
  } catch {
    // config.json missing or malformed -- fall through to default
  }
  return "http://127.0.0.1:19919";
}
