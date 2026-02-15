import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function normalizeSelectedPath(output: string): string {
  return output.trim().replace(/\/$/, "");
}

export function createSystemService() {
  return {
    async pickDirectory(): Promise<{ path: string }> {
      if (process.platform !== "darwin") {
        throw new Error("Directory picker is currently supported on macOS runtime only");
      }

      const script = 'POSIX path of (choose folder with prompt "Select repository directory")';
      const { stdout } = await execFile("osascript", ["-e", script], {
        encoding: "utf8",
      });

      const selectedPath = normalizeSelectedPath(stdout);
      if (!selectedPath) {
        throw new Error("No directory selected");
      }

      return { path: selectedPath };
    },
  };
}
