import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".claude",
  "ide"
);

export interface LockInfo {
  pid: number;
  port: number;
  workspaceFolders: string[];
  ideName: string;
}

export function scanLockFiles(): Map<string, LockInfo> {
  const result = new Map<string, LockInfo>();

  if (!existsSync(LOCK_DIR)) return result;

  const files = readdirSync(LOCK_DIR).filter((f) => f.endsWith(".lock"));

  for (const file of files) {
    try {
      const content = readFileSync(join(LOCK_DIR, file), "utf-8");
      const data = JSON.parse(content);

      if (data.pid && data.port) {
        const key = file.replace(".lock", "");
        result.set(key, {
          pid: data.pid,
          port: data.port,
          workspaceFolders: data.workspaceFolders || [],
          ideName: data.ideName || "unknown",
        });
      }
    } catch {
      // Expected: lock file may be malformed, partially written, or from a crashed process
    }
  }

  return result;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Expected: process does not exist (ESRCH) or no permission (EPERM)
    return false;
  }
}
