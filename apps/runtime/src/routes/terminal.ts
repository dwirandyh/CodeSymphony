import type { FastifyInstance } from "fastify";
import { z } from "zod";

const runTerminalInputSchema = z.object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    mode: z.enum(["stdin", "exec"]).optional(),
});
const interruptTerminalInputSchema = z.object({
    sessionId: z.string().min(1),
});
const killTerminalInputSchema = z.object({
    sessionId: z.string().min(1),
});

export function handleTerminalWebSocket(
    app: FastifyInstance,
    socket: {
        close: (code?: number, reason?: string) => void;
        send: (data: string) => void;
        on: (event: string, listener: (...args: any[]) => void) => void;
        readyState: number;
    },
    request: { query: Record<string, string> },
) {
    const query = request.query as Record<string, string>;
    const sessionId = query.sessionId || "default";
    const cwd = query.cwd || undefined;

    let session;
    try {
        session = app.terminalService.spawn(sessionId, cwd);
    } catch (spawnError) {
        const message = spawnError instanceof Error ? spawnError.message : "Failed to spawn terminal";
        app.logService.log("error", "terminal", `Failed to spawn PTY: ${message}`, { cwd, sessionId });
        socket.close(1011, message);
        return;
    }

    const worktreeId = sessionId.includes(":") ? sessionId.split(":", 1)[0] : undefined;
    app.logService.log(
        "info",
        "terminal",
        `Terminal session connected: ${sessionId}`,
        {
            cwd,
            resolvedCwd: session.resolvedCwd,
            sessionId,
            worktreeId,
        },
        worktreeId ? { worktreeId } : undefined,
    );

    let initialPayloadSent = false;
    const sendInitialPayload = () => {
        if (initialPayloadSent) {
            return;
        }

        initialPayloadSent = true;

        try {
            if (socket.readyState !== 1) {
                return;
            }

            const replay = app.terminalService.getScrollback(sessionId);
            if (replay.length > 0) {
                socket.send(replay);
            }

            const exitEvent = app.terminalService.getExitEvent(sessionId);
            if (exitEvent) {
                socket.send(JSON.stringify({
                    kind: "cs-terminal-event",
                    type: "exit",
                    exitCode: exitEvent.exitCode,
                    signal: exitEvent.signal,
                }));
            }
        } catch {
            // ignore initial payload send errors
        }
    };

    const removeListener = app.terminalService.addListener(
        sessionId,
        (data: string) => {
            try {
                if (socket.readyState === 1) {
                    socket.send(data);
                }
            } catch {
                // ignore send errors
            }
        },
        { replay: false },
    );
    const removeExitListener = app.terminalService.addExitListener(
        sessionId,
        (event) => {
            try {
                if (socket.readyState === 1) {
                    socket.send(JSON.stringify({
                        kind: "cs-terminal-event",
                        type: "exit",
                        exitCode: event.exitCode,
                        signal: event.signal,
                    }));
                }
            } catch {
                // ignore send errors
            }
        },
        { replay: false },
    );

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const message = raw.toString();

        try {
            const parsed = JSON.parse(message) as Record<string, unknown>;
            if (parsed.type === "resize") {
                const cols = Number(parsed.cols) || 80;
                const rows = Number(parsed.rows) || 24;
                app.terminalService.resize(sessionId, cols, rows);
                sendInitialPayload();
                return;
            }
        } catch {
            // Not JSON — treat as raw terminal input
        }

        sendInitialPayload();
        app.terminalService.write(sessionId, message);
    });

    socket.on("close", () => {
        removeListener();
        removeExitListener();
        app.logService.log("info", "terminal", `Terminal session disconnected: ${sessionId}`, { sessionId, worktreeId }, worktreeId ? { worktreeId } : undefined);
    });

    socket.on("error", (error: Error) => {
        app.logService.log("error", "terminal", `Terminal WebSocket error: ${error.message}`, { sessionId, worktreeId }, worktreeId ? { worktreeId } : undefined);
        removeListener();
        removeExitListener();
    });
}

export async function registerTerminalRoutes(app: FastifyInstance) {
    app.get("/terminal/sessions", async (_request, reply) => {
        return reply.send({
            data: app.terminalService.listSessions(),
        });
    });

    app.post("/terminal/run", async (request, reply) => {
        try {
            const input = runTerminalInputSchema.parse(request.body ?? {});
            if (input.mode === "exec") {
                app.terminalService.spawn(input.sessionId, input.cwd, {
                    mode: "exec",
                    command: input.command,
                    replace: true,
                });
            } else {
                app.terminalService.spawn(input.sessionId, input.cwd);
                app.terminalService.write(input.sessionId, `${input.command}\r`);
            }
            return reply.code(204).send();
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to run terminal command";
            return reply.code(400).send({ error: message });
        }
    });

    app.post("/terminal/interrupt", async (request, reply) => {
        try {
            const input = interruptTerminalInputSchema.parse(request.body ?? {});
            if (!app.terminalService.has(input.sessionId)) {
                return reply.code(404).send({ error: "Terminal session not found" });
            }
            app.terminalService.write(input.sessionId, "\u0003");
            return reply.code(204).send();
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to interrupt terminal command";
            return reply.code(400).send({ error: message });
        }
    });

    app.post("/terminal/kill", async (request, reply) => {
        try {
            const input = killTerminalInputSchema.parse(request.body ?? {});
            if (!app.terminalService.has(input.sessionId)) {
                return reply.code(404).send({ error: "Terminal session not found" });
            }
            app.terminalService.kill(input.sessionId);
            await app.filesystemService.cleanupTerminalDropFiles(input.sessionId);
            return reply.code(204).send();
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to close terminal session";
            return reply.code(400).send({ error: message });
        }
    });

    app.get(
        "/terminal/ws",
        { websocket: true },
        (socket, request) => {
            handleTerminalWebSocket(app, socket, { query: request.query as Record<string, string> });
        },
    );
}
