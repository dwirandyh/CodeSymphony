import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

interface ActiveScript {
  process: ChildProcess;
  emitter: EventEmitter;
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

    let cancelled = false;

    async function runSequentially() {
      for (const command of commands) {
        if (cancelled) return;

        const child = spawn(command, {
          shell: true,
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

        const exitCode = await new Promise<number | null>((resolve) => {
          child.on("close", (code) => resolve(code));
          child.on("error", (err) => {
            emitter.emit("data", `Error: ${err.message}\n`);
            resolve(1);
          });
        });

        if (cancelled) return;

        if (exitCode !== 0) {
          emitter.emit("data", `\nCommand exited with code ${exitCode}: ${command}\n`);
          active.delete(worktreeId);
          emitter.emit("end", { success: false });
          return;
        }
      }

      if (!cancelled) {
        active.delete(worktreeId);
        emitter.emit("end", { success: true });
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
