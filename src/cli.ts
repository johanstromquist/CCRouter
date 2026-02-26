#!/usr/bin/env node

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const HOME = homedir();
const CCROUTER_HOME = join(HOME, ".ccrouter");
const APP_DIR = join(CCROUTER_HOME, "app");
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS_JSON = join(CLAUDE_DIR, "settings.json");
const PLIST_NAME = "com.ccrouter.daemon";
const PLIST_DIR = join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step: string, msg: string) {
  console.log(`  [${step}] ${msg}`);
}

function findOnPath(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function readSettingsJson(): Record<string, any> {
  if (existsSync(SETTINGS_JSON)) {
    return JSON.parse(readFileSync(SETTINGS_JSON, "utf-8"));
  }
  return {};
}

function writeSettingsJson(settings: Record<string, any>) {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function copyAppFiles() {
  if (existsSync(APP_DIR)) {
    rmSync(APP_DIR, { recursive: true });
  }
  mkdirSync(APP_DIR, { recursive: true });

  // Copy essential directories and files
  for (const item of ["dist", "data", "hooks", "package.json", "package-lock.json"]) {
    const src = join(PROJECT_ROOT, item);
    if (existsSync(src)) {
      cpSync(src, join(APP_DIR, item), { recursive: true });
    }
  }

  // Copy cursor-extension .vsix files (and extension source as fallback)
  const extSrc = join(PROJECT_ROOT, "cursor-extension");
  const extDst = join(APP_DIR, "cursor-extension");
  mkdirSync(extDst, { recursive: true });
  for (const f of readdirSync(extSrc)) {
    if (f.endsWith(".vsix") || f === "extension.js" || f === "package.json") {
      cpSync(join(extSrc, f), join(extDst, f));
    }
  }

  // Make hooks executable
  chmodSync(join(APP_DIR, "hooks", "session-start.sh"), 0o755);
  chmodSync(join(APP_DIR, "hooks", "session-end.sh"), 0o755);
}

function installDependencies() {
  execSync("npm install --omit=dev", {
    cwd: APP_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function configureMcp() {
  const mcpServerPath = join(APP_DIR, "dist", "mcp-server.js");

  // Remove existing entry
  try {
    execSync("claude mcp remove ccrouter", { stdio: ["pipe", "pipe", "pipe"] });
  } catch {}

  execSync(
    `claude mcp add --transport stdio --scope user ccrouter -- node "${mcpServerPath}"`,
    { stdio: ["pipe", "pipe", "pipe"] }
  );
}

function configureHooksAndPermissions() {
  const settings = readSettingsJson();

  // --- Hooks (additive) ---
  if (!settings.hooks) settings.hooks = {};

  const startCommand = join(APP_DIR, "hooks", "session-start.sh");
  const endCommand = join(APP_DIR, "hooks", "session-end.sh");

  settings.hooks.SessionStart = upsertHookEntry(
    settings.hooks.SessionStart || [],
    startCommand
  );
  settings.hooks.SessionEnd = upsertHookEntry(
    settings.hooks.SessionEnd || [],
    endCommand
  );

  // --- Permissions (additive) ---
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const perm = "mcp__ccrouter__*";
  if (!settings.permissions.allow.includes(perm)) {
    settings.permissions.allow.push(perm);
  }

  writeSettingsJson(settings);
}

/**
 * Add or replace a CCRouter hook in a hook event's entry list.
 * Preserves non-CCRouter hooks.
 */
function upsertHookEntry(
  entries: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>,
  command: string
): typeof entries {
  // Find or create a matcher="*" entry
  let starEntry = entries.find((e) => e.matcher === "*");
  if (!starEntry) {
    starEntry = { matcher: "*", hooks: [] };
    entries.push(starEntry);
  }

  // Remove any old CCRouter hook entries (match on path containing ccrouter + hooks/session-)
  starEntry.hooks = starEntry.hooks.filter(
    (h) => !(h.command && h.command.includes("ccrouter") && h.command.includes("hooks/session-"))
  );

  // Add the new one
  starEntry.hooks.push({ type: "command", command });

  return entries;
}

function installDaemon() {
  if (platform() !== "darwin") {
    console.log("  Skipping launchd (not macOS). Start the daemon manually:");
    console.log(`    node ${join(APP_DIR, "dist", "daemon.js")}`);
    return;
  }

  const nodePath = process.execPath;
  const daemonPath = join(APP_DIR, "dist", "daemon.js");
  const logDir = join(CCROUTER_HOME, "logs");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(PLIST_DIR, { recursive: true });

  // Stop existing daemon
  try {
    execSync(`launchctl bootout gui/$(id -u)/${PLIST_NAME}`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch {}

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${daemonPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${APP_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${join(logDir, "daemon.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(logDir, "daemon.err")}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>`;

  writeFileSync(PLIST_PATH, plist);
  execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_PATH}"`, { stdio: ["pipe", "pipe", "pipe"] });
}

function installExtension() {
  // Find the .vsix
  const extDir = join(APP_DIR, "cursor-extension");
  const vsixFiles = existsSync(extDir)
    ? readdirSync(extDir).filter((f) => f.endsWith(".vsix"))
    : [];

  if (vsixFiles.length === 0) {
    // Try building it on the fly
    try {
      execSync("npx -y @vscode/vsce package --allow-missing-repository", {
        cwd: extDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const rebuilt = readdirSync(extDir).filter((f) => f.endsWith(".vsix"));
      if (rebuilt.length > 0) vsixFiles.push(rebuilt[0]);
    } catch {
      log("6/6", "No .vsix found and could not build one. Install the extension manually.");
      return;
    }
  }

  const vsixPath = join(extDir, vsixFiles[0]);
  let installed = false;

  for (const cli of ["cursor", "code"]) {
    if (findOnPath(cli)) {
      try {
        execSync(`${cli} --install-extension "${vsixPath}" --force`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        log("6/6", `Installed extension via ${cli}.`);
        installed = true;
      } catch {
        log("6/6", `Warning: failed to install via ${cli}.`);
      }
    }
  }

  if (!installed) {
    log("6/6", "Neither 'cursor' nor 'code' found on PATH. Install the .vsix manually:");
    log("6/6", `  cursor --install-extension "${vsixPath}"`);
  }
}

async function setup() {
  console.log("\n=== CCRouter Setup ===\n");

  // Check prerequisites
  if (!findOnPath("claude")) {
    console.error("Error: 'claude' CLI not found on PATH.");
    console.error("Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code");
    process.exit(1);
  }

  log("1/6", "Copying files to ~/.ccrouter/app/...");
  copyAppFiles();
  log("1/6", "Done.");

  log("2/6", "Installing dependencies...");
  installDependencies();
  log("2/6", "Done.");

  log("3/6", "Configuring MCP server...");
  configureMcp();
  log("3/6", "Done.");

  log("4/6", "Configuring hooks and permissions...");
  configureHooksAndPermissions();
  log("4/6", "Done.");

  log("5/6", "Installing daemon...");
  installDaemon();
  log("5/6", "Done.");

  log("6/6", "Installing terminal bridge extension...");
  installExtension();

  // Verify
  console.log("\n=== Setup Complete ===\n");
  console.log("  Verify:    curl http://127.0.0.1:19919/health");
  console.log("  Uninstall: npx ccrouter uninstall");
  console.log("");
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function uninstall() {
  console.log("\n=== CCRouter Uninstall ===\n");

  // 1. Stop and remove daemon
  if (platform() === "darwin") {
    try {
      execSync(`launchctl bootout gui/$(id -u)/${PLIST_NAME}`, { stdio: ["pipe", "pipe", "pipe"] });
      console.log("  Stopped daemon.");
    } catch {
      console.log("  Daemon was not running.");
    }
    if (existsSync(PLIST_PATH)) {
      unlinkSync(PLIST_PATH);
      console.log("  Removed launchd plist.");
    }
  }

  // 2. Remove MCP config
  try {
    execSync("claude mcp remove ccrouter", { stdio: ["pipe", "pipe", "pipe"] });
    console.log("  Removed MCP server config.");
  } catch {
    console.log("  MCP config already removed.");
  }

  // 3. Remove hooks and permission from settings.json
  if (existsSync(SETTINGS_JSON)) {
    const settings = readSettingsJson();

    // Remove CCRouter hooks
    for (const event of ["SessionStart", "SessionEnd"]) {
      if (!settings.hooks?.[event]) continue;
      for (const entry of settings.hooks[event]) {
        if (entry.hooks) {
          entry.hooks = entry.hooks.filter(
            (h: any) => !(h.command && h.command.includes(".ccrouter"))
          );
        }
      }
      // Clean up empty matcher entries
      settings.hooks[event] = settings.hooks[event].filter(
        (e: any) => e.hooks && e.hooks.length > 0
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    // Remove permission
    if (settings.permissions?.allow) {
      settings.permissions.allow = settings.permissions.allow.filter(
        (p: string) => p !== "mcp__ccrouter__*"
      );
      if (settings.permissions.allow.length === 0) {
        delete settings.permissions.allow;
      }
      if (Object.keys(settings.permissions).length === 0) {
        delete settings.permissions;
      }
    }

    writeSettingsJson(settings);
    console.log("  Removed hooks and permissions from settings.json.");
  }

  // 4. Uninstall extension from IDEs
  for (const cli of ["cursor", "code"]) {
    if (findOnPath(cli)) {
      try {
        execSync(`${cli} --uninstall-extension ccrouter-terminal-bridge`, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        console.log(`  Uninstalled extension from ${cli}.`);
      } catch {}
    }
  }

  // 5. Remove app directory (preserve DB and logs)
  if (existsSync(APP_DIR)) {
    rmSync(APP_DIR, { recursive: true });
    console.log("  Removed ~/.ccrouter/app/.");
  }

  console.log("\n  Uninstall complete.");
  console.log("  Note: ~/.ccrouter/ccrouter.db and logs were preserved.");
  console.log("  Run 'rm -rf ~/.ccrouter' to remove all data.\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2];

switch (command) {
  case "setup":
  case "install":
    setup().catch((err) => {
      console.error("\nSetup failed:", err.message);
      process.exit(1);
    });
    break;
  case "uninstall":
  case "remove":
    uninstall().catch((err) => {
      console.error("\nUninstall failed:", err.message);
      process.exit(1);
    });
    break;
  default:
    console.log("CCRouter -- Cross-session communication for Claude Code\n");
    console.log("Usage:");
    console.log("  ccrouter setup       Install and configure CCRouter");
    console.log("  ccrouter uninstall   Remove CCRouter configuration\n");
    break;
}
