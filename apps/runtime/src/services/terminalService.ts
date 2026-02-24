import * as pty from "node-pty";
import { existsSync } from "node:fs";

const MAX_SCROLLBACK_BYTES = 50_000;

export interface TerminalSession {
    id: string;
    ptyProcess: pty.IPty;
    listeners: Set<(data: string) => void>;
    scrollback: string[];
    scrollbackSize: number;
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

    function spawnProcess(cwd?: string): pty.IPty {
        const shellCandidates = resolveShellCandidates();
        const cwdCandidates = resolveCwdCandidates(cwd);
        let lastError: unknown = new Error("Unable to spawn terminal process");

        for (const shell of shellCandidates) {
            if (!existsSync(shell)) {
                continue;
            }

            for (const candidateCwd of cwdCandidates) {
                try {
                    return pty.spawn(shell, [], {
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
    ): TerminalSession {
        const existing = sessions.get(sessionId);
        if (existing) {
            return existing;
        }

        const ptyProcess = spawnProcess(cwd);

        const session: TerminalSession = {
            id: sessionId,
            ptyProcess,
            listeners: new Set(),
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

        ptyProcess.onExit(() => {
            sessions.delete(sessionId);
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

    return { spawn, write, resize, addListener, kill, has, killAll };
}
