import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const MAX_CAPTURED_STDERR_LINES = 12;
const DEFAULT_CLAUDE_EXECUTABLE = "claude";
const COMMON_CLAUDE_EXECUTABLE_PATHS = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
let cachedClaudeExecutable: string | null = null;

export { DEFAULT_CLAUDE_EXECUTABLE };

function resolveExecutablePath(commandOrPath: string): string {
    function findCommonInstalledPath(): string | null {
        for (const candidate of COMMON_CLAUDE_EXECUTABLE_PATHS) {
            if (existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    function resolveByWhich(command: string): string {
        try {
            const resolved = execFileSync("which", [command], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();

            if (resolved.length > 0) {
                return resolved;
            }
        } catch {
            // Fall through and let SDK report a clear executable-not-found error.
        }

        return command;
    }

    if (commandOrPath.includes("/")) {
        if (existsSync(commandOrPath)) {
            return commandOrPath;
        }

        if (commandOrPath !== DEFAULT_CLAUDE_EXECUTABLE) {
            const fallback = resolveByWhich(DEFAULT_CLAUDE_EXECUTABLE);
            if (fallback !== DEFAULT_CLAUDE_EXECUTABLE) {
                return fallback;
            }

            const commonInstalledPath = findCommonInstalledPath();
            if (commonInstalledPath) {
                return commonInstalledPath;
            }
        }

        return commandOrPath;
    }

    const resolved = resolveByWhich(commandOrPath);
    if (resolved !== commandOrPath) {
        return resolved;
    }

    const commonInstalledPath = findCommonInstalledPath();
    if (commonInstalledPath) {
        return commonInstalledPath;
    }

    return commandOrPath;
}

export function dedupePreserveOrder(values: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const value of values) {
        const normalized = value.trim();
        if (normalized.length === 0 || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        unique.push(normalized);
    }

    return unique;
}

export function buildExecutableCandidates(configuredExecutable: string): string[] {
    const resolvedConfigured = resolveExecutablePath(configuredExecutable);
    const resolvedDefault = resolveExecutablePath(DEFAULT_CLAUDE_EXECUTABLE);
    return dedupePreserveOrder([
        cachedClaudeExecutable ?? "",
        configuredExecutable,
        resolvedConfigured,
        DEFAULT_CLAUDE_EXECUTABLE,
        resolvedDefault,
        ...COMMON_CLAUDE_EXECUTABLE_PATHS,
    ]);
}

export function isSpawnEnoent(error: unknown): boolean {
    return error instanceof Error && /spawn .* ENOENT/i.test(error.message);
}

export function selectExecutableForCurrentProcess(candidates: string[], env: NodeJS.ProcessEnv): string {
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ["--version"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                env,
            });
            cachedClaudeExecutable = candidate;
            return candidate;
        } catch (error) {
            if (!isSpawnEnoent(error)) {
                continue;
            }
        }
    }

    return candidates[0] ?? DEFAULT_CLAUDE_EXECUTABLE;
}

export function captureStderrLine(buffer: string[], data: string) {
    const normalized = data.trim();
    if (normalized.length === 0) {
        return;
    }

    buffer.push(normalized);

    if (buffer.length > MAX_CAPTURED_STDERR_LINES) {
        buffer.splice(0, buffer.length - MAX_CAPTURED_STDERR_LINES);
    }
}

export function withClaudeSetupHint(error: unknown, recentStderr: string[], claudeExecutable: string) {
    if (!(error instanceof Error)) {
        return error;
    }

    if (/spawn .* ENOENT/i.test(error.message)) {
        const hintLines = [
            `Claude Code executable was not found: ${claudeExecutable}`,
            "Set CLAUDE_CODE_EXECUTABLE in apps/runtime/.env to a valid path or use `claude`.",
            "Verify binary availability for the runtime user with `which claude` and `claude --version`.",
        ];

        return new Error(hintLines.join("\n"), { cause: error });
    }

    if (!/Claude Code process exited with code 1/i.test(error.message)) {
        return error;
    }

    const hintLines = [
        `Claude Code failed to start. Runtime is using Claude CLI (${claudeExecutable}).`,
        "Ensure the executable exists for the runtime user and run `claude login` for the same user account.",
        "Set CLAUDE_CODE_EXECUTABLE in apps/runtime/.env if your binary path is different.",
    ];

    if (recentStderr.length > 0) {
        hintLines.push("", "Recent Claude stderr:", ...recentStderr);
    }

    return new Error(hintLines.join("\n"), { cause: error });
}
