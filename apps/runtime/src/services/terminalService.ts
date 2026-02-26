import * as pty from "node-pty";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const MAX_SCROLLBACK_BYTES = 50_000;

/**
 * Ensure node-pty's spawn-helper binary has executable permissions.
 * Tauri's resource copying can strip the +x bit, causing posix_spawnp to fail.
 */
function fixSpawnHelperPermissions(): void {
    try {
        const require = createRequire(import.meta.url);
        const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
        const platform = process.platform === "darwin" ? "darwin" : process.platform;
        const arch = process.arch;
        const spawnHelper = join(nodePtyRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper");
        if (existsSync(spawnHelper)) {
            chmodSync(spawnHelper, 0o755);
        }
    } catch {
        // Best-effort; if we can't fix it, pty.spawn will throw with a clear error
    }
}

fixSpawnHelperPermissions();

export interface TerminalSession {
    id: string;
    ptyProcess: pty.IPty;
    listeners: Set<(data: string) => void>;
    exitListeners: Set<(event: { exitCode: number; signal: number }) => void>;
    scrollback: string[];
    scrollbackSize: number;
}

interface SpawnOptions {
    mode?: "shell" | "exec";
    command?: string;
    replace?: boolean;
}

export function createTerminalService() {
    const sessions = new Map<string, TerminalSession>();

    function resolveShellCandidates(): string[] {
        const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]
            .filter((value): value is string => Boolean(value));
        return Array.from(new Set(candidates));
    }

    function resolveCwdCandidates(cwd?: string): string[] {
        const candidates = [cwd, process.env.HOME, "/"]
            .filter((value): value is string => Boolean(value));
        return Array.from(new Set(candidates));
    }

    function spawnProcess(cwd?: string, options?: SpawnOptions): pty.IPty {
        const shellCandidates = resolveShellCandidates();
        const cwdCandidates = resolveCwdCandidates(cwd);
        let lastError: unknown = new Error("Unable to spawn terminal process");
        const mode = options?.mode ?? "shell";
        const command = options?.command;

        for (const shell of shellCandidates) {
            if (!existsSync(shell)) {
                continue;
            }

            for (const candidateCwd of cwdCandidates) {
                try {
                    const args = mode === "exec" ? ["-lc", command ?? ""] : [];
                    return pty.spawn(shell, args, {
                        name: "xterm-256color",
                        cols: 80,
                        rows: 24,
                        cwd: candidateCwd,
                        env: {
                            ...process.env,
                            TERM: "xterm-256color",
                            COLORTERM: "truecolor",
                        } as Record<string, string>,
                    });
                } catch (error) {
                    lastError = error;
                }
            }
        }

        throw lastError;
    }

    function spawn(
        sessionId: string,
        cwd?: string,
        options?: SpawnOptions,
    ): TerminalSession {
        const existing = sessions.get(sessionId);
        if (existing && !options?.replace) {
            return existing;
        }

        const inheritedListeners = existing?.listeners ?? new Set<(data: string) => void>();
        const inheritedExitListeners = existing?.exitListeners ?? new Set<(event: { exitCode: number; signal: number }) => void>();

        if (existing) {
            existing.ptyProcess.kill();
        }

        const ptyProcess = spawnProcess(cwd, options);

        const session: TerminalSession = {
            id: sessionId,
            ptyProcess,
            listeners: inheritedListeners,
            exitListeners: inheritedExitListeners,
            scrollback: [],
            scrollbackSize: 0,
        };

        ptyProcess.onData((data) => {
            // Buffer output for replay on reconnect
            session.scrollback.push(data);
            session.scrollbackSize += data.length;
            while (session.scrollbackSize > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
                const removed = session.scrollback.shift()!;
                session.scrollbackSize -= removed.length;
            }

            for (const listener of session.listeners) {
                listener(data);
            }
        });

        ptyProcess.onExit((event) => {
            const isCurrentSession = sessions.get(sessionId) === session;
            if (isCurrentSession) {
                sessions.delete(sessionId);
            } else {
                return;
            }
            for (const listener of session.exitListeners) {
                listener({
                    exitCode: event.exitCode,
                    signal: event.signal ?? 0,
                });
            }
        });

        sessions.set(sessionId, session);
        return session;
    }

    function write(sessionId: string, data: string): void {
        const session = sessions.get(sessionId);
        if (session) {
            session.ptyProcess.write(data);
        }
    }

    function resize(sessionId: string, cols: number, rows: number): void {
        const session = sessions.get(sessionId);
        if (session) {
            session.ptyProcess.resize(cols, rows);
        }
    }

    function addListener(
        sessionId: string,
        callback: (data: string) => void,
    ): () => void {
        const session = sessions.get(sessionId);
        if (!session) {
            return () => { };
        }

        // Replay buffered output so reconnected clients see the prompt
        if (session.scrollback.length > 0) {
            const replay = session.scrollback.join("");
            callback(replay);
        }

        session.listeners.add(callback);
        return () => {
            session.listeners.delete(callback);
        };
    }

    function addExitListener(
        sessionId: string,
        callback: (event: { exitCode: number; signal: number }) => void,
    ): () => void {
        const session = sessions.get(sessionId);
        if (!session) {
            return () => { };
        }

        session.exitListeners.add(callback);
        return () => {
            session.exitListeners.delete(callback);
        };
    }

    function kill(sessionId: string): void {
        const session = sessions.get(sessionId);
        if (session) {
            session.ptyProcess.kill();
            sessions.delete(sessionId);
        }
    }

    function has(sessionId: string): boolean {
        return sessions.has(sessionId);
    }

    function killAll(): void {
        for (const session of sessions.values()) {
            session.ptyProcess.kill();
        }
        sessions.clear();
    }

    return { spawn, write, resize, addListener, addExitListener, kill, has, killAll };
}
