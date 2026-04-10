import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { buildExecShellArgs, resolveShellCandidates } from "./terminalService.js";

interface ScriptResult {
  success: boolean;
  output: string;
}

const PER_COMMAND_TIMEOUT_MS = 300_000;

function buildScript(commands: string[]): string {
  return commands.join("\n");
}

export async function runScripts(
  commands: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<ScriptResult> {
  if (commands.length === 0) {
    return { success: true, output: "" };
  }

  const mergedEnv = { ...process.env, ...env };
  const script = buildScript(commands);
  const timeoutMs = Math.max(PER_COMMAND_TIMEOUT_MS, commands.length * PER_COMMAND_TIMEOUT_MS);

  for (const shell of resolveShellCandidates()) {
    if (!existsSync(shell)) {
      continue;
    }

    const result = await new Promise<ScriptResult | null>((resolve) => {
      const child = spawn(shell, buildExecShellArgs(shell, script), {
        cwd,
        env: mergedEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let settled = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk.toString());
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        resolve({
          success: false,
          output: `Script timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
        });
      }, timeoutMs);

      child.on("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(null);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const combined = [...stdoutChunks, ...stderrChunks].join("").trim();
        if (code === 0) {
          resolve({ success: true, output: combined });
          return;
        }

        resolve({
          success: false,
          output: combined || `Script failed with exit code ${code ?? "unknown"}.`,
        });
      });
    });

    if (result) {
      return result;
    }
  }

  return {
    success: false,
    output: "Unable to run script commands.",
  };
}
