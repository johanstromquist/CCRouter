const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CCROUTER_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".ccrouter"
);
const BRIDGES_DIR = path.join(CCROUTER_DIR, "bridges");
const SESSIONS_DIR = path.join(CCROUTER_DIR, "last-sessions");

const IS_WINDOWS = process.platform === "win32";

let server = null;
let registryFile = null;

// In-memory maps for terminal identification
// sessionId -> terminal processId (set via /notify from daemon)
const sessionTerminalMap = new Map();
// tty -> {sessionId, friendlyName, cwd} (Mac only, backwards compat)
const ttySessionMap = new Map();

function activate(context) {
  fs.mkdirSync(BRIDGES_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const result = await sendToTerminal(data);
          res.writeHead(result.ok ? 200 : 404, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    } else if (req.method === "POST" && req.url === "/notify") {
      // Daemon notifies us when a session registers or gets renamed.
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { tty, session_id, friendly_name, cwd, pid } =
            JSON.parse(body);

          if (session_id) {
            // Try to find which terminal this session is in
            const terminalPid = await findTerminalPidForSession(pid, tty);
            if (terminalPid) {
              sessionTerminalMap.set(session_id, terminalPid);
            }
            if (tty) {
              ttySessionMap.set(tty, {
                sessionId: session_id,
                friendlyName: friendly_name,
                cwd,
              });
            }
            persistSession(cwd, session_id, friendly_name, tty);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    } else if (req.method === "GET" && req.url === "/terminals") {
      const terminals = await getTerminalMap();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(terminals));
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          terminals: vscode.window.terminals.length,
          platform: process.platform,
          sessions: sessionTerminalMap.size,
        })
      );
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  // Listen on 0.0.0.0 so the daemon can reach us from the network
  const bridgeHost = vscode.workspace
    .getConfiguration("ccrouter")
    .get("bridgeHost", "0.0.0.0");

  server.listen(0, bridgeHost, () => {
    const port = server.address().port;
    console.log(
      `CCRouter Terminal Bridge listening on ${bridgeHost}:${port} (${process.platform})`
    );

    // Write local registry file
    registryFile = path.join(BRIDGES_DIR, `${port}.json`);
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        port,
        pid: process.pid,
        host: bridgeHost,
        platform: process.platform,
        started: Date.now(),
      })
    );

    // Register with remote daemon if configured
    registerWithDaemon(port);
  });

  server.on("error", (err) => {
    console.error("CCRouter Terminal Bridge error:", err);
  });

  // Re-register with daemon every 60s to survive daemon restarts,
  // bridge file cleanup, and sleep/wake cycles
  let heartbeatInterval = null;
  const startHeartbeat = (port) => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      registerWithDaemon(port);
    }, 60_000);
  };

  context.subscriptions.push({
    dispose: () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (server) server.close();
      if (registryFile) {
        try {
          fs.unlinkSync(registryFile);
        } catch {}
      }
    },
  });

  // Start heartbeat once the server port is known
  server.on("listening", () => {
    startHeartbeat(server.address().port);
  });
}

function registerWithDaemon(port) {
  let daemonUrl = "";
  const configPath = path.join(CCROUTER_DIR, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    daemonUrl = config.daemonUrl || "";
  } catch {}
  if (!daemonUrl) {
    daemonUrl = vscode.workspace
      .getConfiguration("ccrouter")
      .get("daemonUrl", "");
  }

  if (!daemonUrl) return;

  // Determine this machine's IP
  const os = require("os");
  const nets = os.networkInterfaces();
  let myIp = "127.0.0.1";
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        myIp = addr.address;
        break;
      }
    }
  }

  const bridgeInfo = JSON.stringify({
    port,
    host: myIp,
    pid: process.pid,
    platform: process.platform,
  });
  const url = new (require("url").URL)(`${daemonUrl}/register-bridge`);
  const httpModule =
    url.protocol === "https:" ? require("https") : require("http");

  const req = httpModule.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bridgeInfo),
      },
      timeout: 5000,
    },
    () => {
      console.log(
        `CCRouter Bridge registered with daemon at ${daemonUrl} (${myIp}:${port})`
      );
    }
  );
  req.on("error", (err) => {
    console.log(
      `CCRouter Bridge failed to register with daemon: ${err.message}`
    );
  });
  req.write(bridgeInfo);
  req.end();
}

// Find which terminal a session's process belongs to.
// Returns the terminal's processId if found.
async function findTerminalPidForSession(sessionPid, tty) {
  if (!sessionPid && !tty) return null;

  for (const terminal of vscode.window.terminals) {
    const termPid = await terminal.processId;
    if (!termPid) continue;

    // Direct PID match (session is the shell itself, unlikely but possible)
    if (sessionPid && termPid === sessionPid) return termPid;

    // Check if session PID is a descendant of the terminal's shell
    if (sessionPid && isDescendant(termPid, sessionPid)) return termPid;

    // TTY match (Mac only)
    if (tty && !IS_WINDOWS) {
      try {
        const termTty = execSync(`ps -o tty= -p ${termPid}`, {
          encoding: "utf-8",
        }).trim();
        if (termTty === tty) return termPid;
      } catch {}
    }
  }

  return null;
}

// Check if childPid is a descendant of parentPid
function isDescendant(parentPid, childPid) {
  try {
    if (IS_WINDOWS) {
      // Windows: walk up process tree from child using wmic
      let currentPid = childPid;
      for (let i = 0; i < 10; i++) {
        const out = execSync(
          `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${currentPid}').ParentProcessId"`,
          { encoding: "utf-8", timeout: 3000 }
        ).trim();
        const ppid = parseInt(out, 10);
        if (!ppid || ppid <= 1) return false;
        if (ppid === parentPid) return true;
        currentPid = ppid;
      }
    } else {
      // Unix: walk up from child using ps
      let currentPid = childPid;
      for (let i = 0; i < 10; i++) {
        const ppid = parseInt(
          execSync(`ps -o ppid= -p ${currentPid}`, {
            encoding: "utf-8",
          }).trim(),
          10
        );
        if (!ppid || ppid <= 1) return false;
        if (ppid === parentPid) return true;
        currentPid = ppid;
      }
    }
  } catch {}
  return false;
}

// Unified send: accepts {session_id, text} or {tty, text} or {pid, text}
async function sendToTerminal(data) {
  const { session_id, tty, pid, text } = data;
  let terminal = null;
  let method = "";

  // 1. Try session_id -> terminal map
  if (session_id && sessionTerminalMap.has(session_id)) {
    const termPid = sessionTerminalMap.get(session_id);
    terminal = await findTerminalByProcessId(termPid);
    method = "session_id";
  }

  // 2. Try tty (Mac)
  if (!terminal && tty && !IS_WINDOWS) {
    terminal = await findTerminalByTty(tty);
    method = "tty";
  }

  // 3. Try pid (find terminal whose shell is ancestor of this pid)
  if (!terminal && pid) {
    for (const t of vscode.window.terminals) {
      const termPid = await t.processId;
      if (termPid && isDescendant(termPid, pid)) {
        terminal = t;
        method = "pid_descendant";
        break;
      }
    }
  }

  // 4. Fallback: if only one terminal, use it
  if (!terminal && vscode.window.terminals.length === 1) {
    terminal = vscode.window.terminals[0];
    method = "single_terminal_fallback";
  }

  if (!terminal) {
    return {
      ok: false,
      error: `No terminal found for session_id=${session_id} tty=${tty} pid=${pid}`,
    };
  }

  // Deliver the text
  terminal.show(false);
  await sleep(50);

  const config = vscode.workspace.getConfiguration("terminal.integrated");
  const previous = config.get("ignoreBracketedPasteMode", false);

  try {
    if (!previous) {
      await config.update(
        "ignoreBracketedPasteMode",
        true,
        vscode.ConfigurationTarget.Global
      );
      await sleep(50);
    }

    await vscode.commands.executeCommand(
      "workbench.action.terminal.sendSequence",
      { text }
    );
    await sleep(50);
  } finally {
    if (!previous) {
      await config.update(
        "ignoreBracketedPasteMode",
        false,
        vscode.ConfigurationTarget.Global
      );
    }
  }

  const enterPause = vscode.workspace
    .getConfiguration("ccrouter")
    .get("enterPauseMs", 3000);

  sleep(enterPause).then(() =>
    vscode.commands.executeCommand(
      "workbench.action.terminal.sendSequence",
      { text: "\u000d" }
    )
  );

  return { ok: true, terminal: terminal.name, method };
}

async function findTerminalByProcessId(targetPid) {
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (pid === targetPid) return terminal;
  }
  return null;
}

async function findTerminalByTty(tty) {
  // Direct match
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (!pid) continue;
    try {
      const termTty = execSync(`ps -o tty= -p ${pid}`, {
        encoding: "utf-8",
      }).trim();
      if (termTty === tty) return terminal;
    } catch {
      continue;
    }
  }

  // Fallback: child process owns the tty
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (!pid) continue;
    try {
      const descendants = execSync(`pgrep -P ${pid} 2>/dev/null`, {
        encoding: "utf-8",
      })
        .trim()
        .split("\n");
      for (const childPid of descendants) {
        if (!childPid) continue;
        const childTty = execSync(`ps -o tty= -p ${childPid}`, {
          encoding: "utf-8",
        }).trim();
        if (childTty === tty) return terminal;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Persist session info for claude-r
function persistSession(cwd, sessionId, friendlyName, tty) {
  if (!cwd) return;
  const crypto = require("crypto");
  const key = crypto.createHash("md5").update(cwd).digest("hex");
  const filePath = path.join(SESSIONS_DIR, `${key}.json`);

  let sessions = [];
  try {
    sessions = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(sessions)) sessions = [];
  } catch {}

  const existing = sessions.findIndex(
    (s) => s.sessionId === sessionId || s.tty === tty
  );
  const entry = {
    sessionId,
    friendlyName,
    tty: tty || null,
    cwd,
    updatedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    sessions[existing] = entry;
  } else {
    sessions.push(entry);
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  sessions = sessions.slice(0, 10);

  fs.writeFileSync(filePath, JSON.stringify(sessions, null, 2));
}

async function getTerminalMap() {
  const results = [];
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    let tty = null;
    if (pid && !IS_WINDOWS) {
      try {
        tty = execSync(`ps -o tty= -p ${pid}`, {
          encoding: "utf-8",
        }).trim();
      } catch {}
    }
    results.push({ name: terminal.name, pid, tty, platform: process.platform });
  }
  return results;
}

function deactivate() {
  if (server) server.close();
  if (registryFile) {
    try {
      fs.unlinkSync(registryFile);
    } catch {}
  }
}

module.exports = { activate, deactivate };
