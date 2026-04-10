import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { buildExecShellArgs, resolveShellCandidates } from "./terminalService.js";

interface ActiveScript {
  process: ChildProcess;
  emitter: EventEmitter;
}

function buildScript(commands: string[]): string {
  return commands.join("\n");
}

export function createScriptStreamService() {
  const active = new Map<string, ActiveScript>();

  function startSetupStream(
    worktreeId: string,
    commands: string[],
    cwd: string,
    env: Record<string, string>,
  ): EventEmitter {
    // Kill any existing process for this worktree
    stopScript(worktreeId);

    const emitter = new EventEmitter();
    const mergedEnv = { ...process.env, ...env };
    const script = buildScript(commands);

    let cancelled = false;

    async function runSequentially() {
      for (const shell of resolveShellCandidates()) {
        if (cancelled) return;
        if (!existsSync(shell)) {
          continue;
        }

        const child = spawn(shell, buildExecShellArgs(shell, script), {
          stdio: ["ignore", "pipe", "pipe"],
          cwd,
          env: mergedEnv,
        });

        const entry = active.get(worktreeId);
        if (entry) {
          entry.process = child;
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          emitter.emit("data", chunk.toString());
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          emitter.emit("data", chunk.toString());
        });

        const result = await new Promise<{ success: boolean; spawnError: boolean }>((resolve) => {
          let settled = false;

          child.on("close", (code) => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({ success: code === 0, spawnError: false });
          });
          child.on("error", (err) => {
            if (settled) {
              return;
            }
            settled = true;
            emitter.emit("data", `Error: ${err.message}\n`);
            resolve({ success: false, spawnError: true });
          });
        });

        if (cancelled) return;

        if (result.spawnError) {
          continue;
        }

        active.delete(worktreeId);
        emitter.emit("end", { success: result.success });
        return;
      }

      if (!cancelled) {
        active.delete(worktreeId);
        emitter.emit("end", { success: false });
      }
    }

    active.set(worktreeId, { process: null as unknown as ChildProcess, emitter });

    void runSequentially();

    return emitter;
  }

  function stopScript(worktreeId: string): void {
    const entry = active.get(worktreeId);
    if (!entry) return;

    active.delete(worktreeId);

    try {
      entry.process?.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }

    entry.emitter.emit("end", { success: false });
  }

  function isRunning(worktreeId: string): boolean {
    return active.has(worktreeId);
  }

  return { startSetupStream, stopScript, isRunning };
}
