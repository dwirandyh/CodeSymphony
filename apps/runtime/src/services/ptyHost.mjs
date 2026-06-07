// PTY host sidecar — runs under Node (not Bun) so node-pty can spawn PTYs.
// The Bun runtime drives this process over stdin/stdout using newline-delimited
// JSON. Raw PTY bytes are base64-encoded to stay newline-safe on the wire.
//
// Why this exists: Bun's built-in PTY (`Bun.spawn({ terminal })`) stalls
// full-screen TUI apps such as opencode/opentui. node-pty renders them
// correctly, but cannot be loaded inside Bun (`posix_spawnp failed`). Running
// node-pty in a dedicated Node child sidesteps both problems.

import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as nodePty from "node-pty";

const require = createRequire(import.meta.url);
const sessions = new Map();
let spawnHelperPermissionsFixed = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function logError(message) {
  process.stderr.write(`[pty-host] ${message}\n`);
}

// node-pty's spawn-helper can lose its +x bit when copied into packaged app
// bundles, which makes posix_spawnp fail. Restore it before the first spawn.
function fixSpawnHelperPermissions() {
  if (spawnHelperPermissionsFixed) {
    return;
  }
  spawnHelperPermissionsFixed = true;
  try {
    const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
    const platform = process.platform === "darwin" ? "darwin" : process.platform;
    const arch = process.arch;
    const candidates = [
      join(nodePtyRoot, "build", "Release", "spawn-helper"),
      join(nodePtyRoot, "build", "Debug", "spawn-helper"),
      join(nodePtyRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
    ];
    for (const spawnHelper of candidates) {
      if (existsSync(spawnHelper)) {
        chmodSync(spawnHelper, 0o755);
        return;
      }
    }
  } catch {
    // Best-effort; pty.spawn will throw a clear error if it still fails.
  }
}

function handleSpawn(command) {
  const { id, file, args, cols, rows, cwd, env } = command;
  fixSpawnHelperPermissions();

  let term;
  try {
    const name = process.platform === "win32" ? "xterm-color" : command.name;
    term = nodePty.spawn(file, args ?? [], {
      name,
      cols,
      rows,
      cwd,
      env,
      encoding: null,
    });
  } catch (error) {
    send({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
    return;
  }

  sessions.set(id, term);
  send({ type: "spawned", id, pid: term.pid });

  term.onData((data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    send({ type: "data", id, data: buffer.toString("base64") });
  });

  term.onExit(({ exitCode, signal }) => {
    sessions.delete(id);
    send({
      type: "exit",
      id,
      exitCode: Number.isInteger(exitCode) ? exitCode : 0,
      signal: typeof signal === "number" ? signal : 0,
    });
  });
}

function handleWrite(command) {
  const term = sessions.get(command.id);
  if (!term) {
    return;
  }
  try {
    term.write(Buffer.from(command.data, "base64"));
  } catch (error) {
    logError(`write failed for ${command.id}: ${error instanceof Error ? error.message : error}`);
  }
}

function handleResize(command) {
  const term = sessions.get(command.id);
  if (!term) {
    return;
  }
  try {
    term.resize(command.cols, command.rows);
  } catch (error) {
    logError(`resize failed for ${command.id}: ${error instanceof Error ? error.message : error}`);
  }
}

function handleKill(command) {
  const term = sessions.get(command.id);
  if (!term) {
    return;
  }
  try {
    term.kill(command.signal);
  } catch (error) {
    logError(`kill failed for ${command.id}: ${error instanceof Error ? error.message : error}`);
  }
}

function handleCommand(command) {
  switch (command.type) {
    case "spawn":
      handleSpawn(command);
      break;
    case "write":
      handleWrite(command);
      break;
    case "resize":
      handleResize(command);
      break;
    case "kill":
      handleKill(command);
      break;
    default:
      logError(`unknown command type: ${command.type}`);
  }
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIndex = stdinBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (line.trim().length > 0) {
      try {
        handleCommand(JSON.parse(line));
      } catch (error) {
        logError(`failed to parse command: ${error instanceof Error ? error.message : error}`);
      }
    }
    newlineIndex = stdinBuffer.indexOf("\n");
  }
});

// When the parent (Bun runtime) goes away, tear down every PTY.
process.stdin.on("end", () => {
  for (const term of sessions.values()) {
    try {
      term.kill();
    } catch {
      // already gone
    }
  }
  process.exit(0);
});

send({ type: "ready" });
