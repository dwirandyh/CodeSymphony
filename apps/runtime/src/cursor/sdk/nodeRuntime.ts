import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function isBunRuntime(): boolean {
  return "Bun" in globalThis;
}

export function shouldRunCursorSdkInNodeProcess(): boolean {
  if (!isBunRuntime()) {
    return false;
  }

  const override = process.env.CODESYMPHONY_CURSOR_SDK_FORCE_IN_PROCESS?.trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes") {
    return false;
  }

  return true;
}

export function resolveNodeExecutable(): string {
  const override = process.env.CODESYMPHONY_NODE_EXECUTABLE?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  if (!isBunRuntime()) {
    return process.execPath;
  }

  const home = homedir();
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
    home ? join(home, ".local", "bin", "node") : "",
    home ? join(home, ".nvm", "current", "bin", "node") : "",
  ].filter((candidate) => candidate.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "node";
}