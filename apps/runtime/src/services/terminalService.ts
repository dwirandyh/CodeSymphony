import * as pty from "node-pty";

export interface TerminalSession {
    id: string;
    ptyProcess: pty.IPty;
    listeners: Set<(data: string) => void>;
}

export function createTerminalService() {
    const sessions = new Map<string, TerminalSession>();

    function spawn(
        sessionId: string,
        cwd?: string,
    ): TerminalSession {
        const existing = sessions.get(sessionId);
        if (existing) {
            return existing;
        }

        const shell = process.env.SHELL || "/bin/zsh";
        const ptyProcess = pty.spawn(shell, [], {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: cwd || process.env.HOME || "/",
            env: {
                ...process.env,
                TERM: "xterm-256color",
                COLORTERM: "truecolor",
            } as Record<string, string>,
        });

        const session: TerminalSession = {
            id: sessionId,
            ptyProcess,
            listeners: new Set(),
        };

        ptyProcess.onData((data) => {
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
