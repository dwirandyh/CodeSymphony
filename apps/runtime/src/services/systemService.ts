import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function normalizeSelectedPath(output: string): string {
  return output.trim().replace(/\/$/, "");
}

export function createSystemService() {
  async function openFileDefaultApp(targetPath: string): Promise<void> {
    const trimmedPath = targetPath.trim();
    if (trimmedPath.length === 0) {
      throw new Error("File path is required");
    }

    try {
      if (process.platform === "darwin") {
        await execFile("open", [trimmedPath], { encoding: "utf8" });
        return;
      }

      if (process.platform === "linux") {
        await execFile("xdg-open", [trimmedPath], { encoding: "utf8" });
        return;
      }

      if (process.platform === "win32") {
        await execFile("cmd", ["/c", "start", "", trimmedPath], { encoding: "utf8" });
        return;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error("No default file opener command found on this system");
      }

      const message = error instanceof Error ? error.message : "Unable to open file";
      throw new Error(`Unable to open file with default app: ${message}`);
    }

    throw new Error(`Opening files is not supported on platform: ${process.platform}`);
  }

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
    openFileDefaultApp,
  };
}
