import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const SHELL_ENV_MARKER = "__CODESYMPHONY_SHELL_ENV__";

let cachedInteractiveShellEnv: NodeJS.ProcessEnv | null = null;

function parseEnvOutput(rawOutput: string): NodeJS.ProcessEnv {
  const marker = `${SHELL_ENV_MARKER}\0`;
  const markerIndex = rawOutput.indexOf(marker);
  if (markerIndex === -1) {
    return {};
  }

  const envOutput = rawOutput.slice(markerIndex + marker.length);
  const result: NodeJS.ProcessEnv = {};

  for (const entry of envOutput.split("\0")) {
    if (!entry) {
      continue;
    }

    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    result[key] = value;
  }

  return result;
}

function dedupePathSegments(pathValue: string): string {
  const unique = new Set<string>();
  const ordered: string[] = [];

  for (const segment of pathValue.split(":")) {
    const normalized = segment.trim();
    if (!normalized || unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    ordered.push(normalized);
  }

  return ordered.join(":");
}

export function mergePathValues(preferred?: string, fallback?: string): string | undefined {
  const segments = [preferred, fallback]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(":");

  if (!segments) {
    return undefined;
  }

  return dedupePathSegments(segments);
}

function resolveShellExecutable(baseEnv: NodeJS.ProcessEnv): string | null {
  const candidates = [baseEnv.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function loadInteractiveShellEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (cachedInteractiveShellEnv) {
    return { ...cachedInteractiveShellEnv };
  }

  const shell = resolveShellExecutable(baseEnv);
  if (!shell) {
    return {};
  }

  try {
    const shellArgs = /(?:^|\/)(?:zsh|bash)$/.test(shell)
      ? ["-lic", `printf '%s\\0' '${SHELL_ENV_MARKER}'; env -0`]
      : ["-lc", `printf '%s\\0' '${SHELL_ENV_MARKER}'; env -0`];

    const output = execFileSync(shell, shellArgs, {
      encoding: "utf8",
      env: {
        ...baseEnv,
        TERM: baseEnv.TERM ?? "xterm-256color",
      },
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });

    cachedInteractiveShellEnv = parseEnvOutput(output);
    return { ...cachedInteractiveShellEnv };
  } catch {
    return {};
  }
}

export function buildClaudeRuntimeEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shellEnv = loadInteractiveShellEnv(baseEnv);
  const mergedEnv = { ...baseEnv };

  for (const [key, value] of Object.entries(shellEnv)) {
    if ((mergedEnv[key] === undefined || mergedEnv[key] === "") && typeof value === "string" && value.length > 0) {
      mergedEnv[key] = value;
    }
  }

  const mergedPath = mergePathValues(shellEnv.PATH, baseEnv.PATH);
  if (mergedPath) {
    mergedEnv.PATH = mergedPath;
  }

  return mergedEnv;
}

export function resetInteractiveShellEnvCache(): void {
  cachedInteractiveShellEnv = null;
}

export const __testing = {
  parseEnvOutput,
  mergePathValues,
  resetInteractiveShellEnvCache,
};
