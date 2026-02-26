const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BRIDGES_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".ccrouter",
  "bridges"
);

let server = null;
let registryFile = null;

function activate(context) {
  fs.mkdirSync(BRIDGES_DIR, { recursive: true });

  server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { tty, text } = JSON.parse(body);
          const result = await sendToTerminalByTty(tty, text);
          res.writeHead(result.ok ? 200 : 404, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(result));
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
        })
      );
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });

  // Use port 0 to let the OS assign an available port
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    console.log(`CCRouter Terminal Bridge listening on port ${port}`);

    // Write registry file so bridge clients can discover us
    registryFile = path.join(BRIDGES_DIR, `${port}.json`);
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ port, pid: process.pid, started: Date.now() })
    );
  });

  server.on("error", (err) => {
    console.error("CCRouter Terminal Bridge error:", err);
  });

  context.subscriptions.push({
    dispose: () => {
      if (server) server.close();
      if (registryFile) {
        try {
          fs.unlinkSync(registryFile);
        } catch {}
      }
    },
  });
}

async function getTerminalMap() {
  const results = [];
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    let tty = null;
    if (pid) {
      try {
        tty = execSync(`ps -o tty= -p ${pid}`, {
          encoding: "utf-8",
        }).trim();
      } catch {
        // process may have exited
      }
    }
    results.push({ name: terminal.name, pid, tty });
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToTerminalByTty(tty, text) {
  const terminal = await findTerminalByTty(tty);
  if (!terminal) {
    return { ok: false, error: `No terminal found for tty ${tty}` };
  }

  // Focus the target terminal so sendSequence targets it
  terminal.show(false);
  await sleep(50);

  // Toggle ignoreBracketedPasteMode on just for this send, then restore it.
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

    // Send the text (without carriage return)
    await vscode.commands.executeCommand(
      "workbench.action.terminal.sendSequence",
      { text }
    );
    await sleep(50);
  } finally {
    // Restore paste mode BEFORE sending CR, so the CR is treated
    // as a normal keypress rather than part of the paste
    if (!previous) {
      await config.update(
        "ignoreBracketedPasteMode",
        false,
        vscode.ConfigurationTarget.Global
      );
    }
  }

  // Schedule the CR after the paste detection window closes.
  // Do this asynchronously so the HTTP response returns immediately
  // (the MCP server has a 3s timeout, and enterPauseMs defaults to 3s).
  const enterPause = vscode.workspace
    .getConfiguration("ccrouter")
    .get("enterPauseMs", 3000);

  // Fire-and-forget: wait for paste window, then send CR
  sleep(enterPause).then(() =>
    vscode.commands.executeCommand(
      "workbench.action.terminal.sendSequence",
      { text: "\u000d" }
    )
  );

  return { ok: true, terminal: terminal.name, tty, method: "sendSequence" };
}

async function findTerminalByTty(tty) {
  // Direct match: terminal shell PID owns the tty
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

  // Fallback: child process of terminal shell owns the tty
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

function deactivate() {
  if (server) server.close();
  if (registryFile) {
    try {
      fs.unlinkSync(registryFile);
    } catch {}
  }
}

module.exports = { activate, deactivate };
