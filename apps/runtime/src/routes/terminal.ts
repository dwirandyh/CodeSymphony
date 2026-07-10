import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RenameTerminalTabTitleInputSchema, TerminalAgentHookEventSchema, summarizeTerminalData } from "@codesymphony/shared-types";
import { mapTerminalAgentEvent } from "../services/terminalAgentStatusMap.js";
import { appendRuntimeDebugLog } from "./debug.js";

const TERMINAL_TYPING_DEBUG_PREFIX = "[DEBUG-terminal-typing]";

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
const createTerminalTabInputSchema = z.object({
    worktreeId: z.string().min(1),
});
const listTerminalTabsQuerySchema = z.object({
    worktreeId: z.string().min(1).optional(),
});

type TerminalSocket = {
    send: (data: string) => void;
    readyState: number;
};

const terminalSessionSockets = new Map<string, Set<TerminalSocket>>();

function registerTerminalSessionSocket(sessionId: string, socket: TerminalSocket): () => void {
    let sockets = terminalSessionSockets.get(sessionId);
    if (!sockets) {
        sockets = new Set();
        terminalSessionSockets.set(sessionId, sockets);
    }

    sockets.add(socket);
    return () => {
        const currentSockets = terminalSessionSockets.get(sessionId);
        if (!currentSockets) {
            return;
        }

        currentSockets.delete(socket);
        if (currentSockets.size === 0) {
            terminalSessionSockets.delete(sessionId);
        }
    };
}

function broadcastTerminalGeometry(
    sessionId: string,
    cols: number,
    rows: number,
    excludeSocket?: TerminalSocket,
): void {
    const sockets = terminalSessionSockets.get(sessionId);
    if (!sockets) {
        return;
    }

    const payload = JSON.stringify({
        kind: "cs-terminal-event",
        type: "geometry",
        cols,
        rows,
    });

    for (const sessionSocket of sockets) {
        if (sessionSocket === excludeSocket || sessionSocket.readyState !== 1) {
            continue;
        }

        try {
            sessionSocket.send(payload);
        } catch {
            // ignore send errors
        }
    }
}

export function resetTerminalSessionSocketsForTests(): void {
    terminalSessionSockets.clear();
}

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
    const viewport = query.viewport === "remote" ? "remote" as const : "authoritative" as const;
    const unregisterSessionViewer = app.terminalService.registerSessionViewer(
        sessionId,
        viewport,
    );
    const unregisterSessionSocket = registerTerminalSessionSocket(sessionId, socket);

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
    const sendInitialPayload = async () => {
        if (initialPayloadSent) {
            return;
        }

        initialPayloadSent = true;

        try {
            if (socket.readyState !== 1) {
                return;
            }

            // Structured attach frame: the client restores deterministically from
            // the headless emulator's snapshot (serialized screen + modes + cwd)
            // instead of replaying raw scrollback and guessing the alt-screen
            // state. This is what lets a reattaching client repaint a running TUI.
            const snapshot = await app.terminalService.getAttachSnapshot(sessionId);
            if (socket.readyState === 1) {
                socket.send(JSON.stringify({
                    kind: "cs-terminal-event",
                    type: "attach",
                    snapshotAnsi: snapshot.snapshotAnsi,
                    rehydrateSequences: snapshot.rehydrateSequences,
                    modes: snapshot.modes,
                    cwd: snapshot.cwd,
                    cols: snapshot.cols,
                    rows: snapshot.rows,
                }));
            }

            const exitEvent = app.terminalService.getExitEvent(sessionId);
            if (exitEvent && socket.readyState === 1) {
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
            const willSend = socket.readyState === 1;
            appendRuntimeDebugLog({
                source: "terminal.output",
                message: `${TERMINAL_TYPING_DEBUG_PREFIX} server.ws.output.forward`,
                data: {
                    sessionId,
                    worktreeId,
                    socketReadyState: socket.readyState,
                    sent: willSend,
                    outputSummary: summarizeTerminalData(data),
                },
            });
            // Decisive delivery instrument: when the PTY emits the alt-screen
            // enter (a full-screen TUI starting), log whether we actually had an
            // open socket to send it on. Pairs with the client's
            // `client.altEnterChunk` — server "sent" + client "received: 0" means
            // the bytes were dropped in transit, not a render bug.
            if (data.includes("\x1b[?1049h")) {
                appendRuntimeDebugLog({
                    source: "terminal.render",
                    message: "server.altEnterForward",
                    data: {
                        sessionId,
                        worktreeId,
                        socketReadyState: socket.readyState,
                        willSend,
                        chunkLength: data.length,
                    },
                });
            }
            try {
                if (willSend) {
                    socket.send(data);
                }
            } catch (sendError) {
                appendRuntimeDebugLog({
                    source: "terminal.render",
                    message: "server.sendError",
                    data: {
                        sessionId,
                        worktreeId,
                        message: sendError instanceof Error ? sendError.message : String(sendError),
                    },
                });
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
                const authoritative = viewport === "authoritative" && parsed.authoritative !== false;
                app.terminalService.resize(sessionId, cols, rows, { authoritative });
                if (authoritative) {
                    broadcastTerminalGeometry(sessionId, cols, rows, socket);
                }
                return sendInitialPayload();
            }
        } catch {
            // Not JSON — treat as raw terminal input
        }

        appendRuntimeDebugLog({
            source: "terminal.input",
            message: `${TERMINAL_TYPING_DEBUG_PREFIX} server.ws.input.received`,
            data: {
                sessionId,
                worktreeId,
                socketReadyState: socket.readyState,
                initialPayloadSent,
                inputSummary: summarizeTerminalData(message),
            },
        });
        const payload = sendInitialPayload();
        app.terminalService.write(sessionId, message);
        appendRuntimeDebugLog({
            source: "terminal.input",
            message: `${TERMINAL_TYPING_DEBUG_PREFIX} server.ws.input.writeIssued`,
            data: {
                sessionId,
                worktreeId,
                socketReadyState: socket.readyState,
                inputSummary: summarizeTerminalData(message),
            },
        });
        return payload;
    });

    socket.on("close", () => {
        unregisterSessionSocket();
        unregisterSessionViewer();
        removeListener();
        removeExitListener();
        app.logService.log("info", "terminal", `Terminal session disconnected: ${sessionId}`, { sessionId, worktreeId }, worktreeId ? { worktreeId } : undefined);
    });

    socket.on("error", (error: Error) => {
        unregisterSessionSocket();
        unregisterSessionViewer();
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

    app.get("/terminal/tabs", async (request, reply) => {
        const query = listTerminalTabsQuerySchema.parse(request.query ?? {});
        return reply.send({
            data: await app.terminalService.listTabs(query.worktreeId),
        });
    });

    app.post("/terminal/tabs", async (request, reply) => {
        try {
            const input = createTerminalTabInputSchema.parse(request.body ?? {});
            const tab = await app.terminalService.createTab(input.worktreeId);
            app.workspaceEventHub.emit("terminal.tab.created", { worktreeId: tab.worktreeId });
            return reply.code(201).send({ data: tab });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to create terminal tab";
            return reply.code(400).send({ error: message });
        }
    });

    app.patch("/terminal/tabs/:tabId/title", async (request, reply) => {
        const { tabId } = request.params as { tabId: string };
        try {
            const input = RenameTerminalTabTitleInputSchema.parse(request.body ?? {});
            const tab = await app.terminalService.renameTab(tabId, input.title);
            if (!tab) {
                return reply.code(404).send({ error: "Terminal tab not found" });
            }
            app.workspaceEventHub.emit("terminal.tab.updated", { worktreeId: tab.worktreeId });
            return reply.send({ data: tab });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to rename terminal tab";
            return reply.code(400).send({ error: message });
        }
    });

    app.delete("/terminal/tabs/:tabId", async (request, reply) => {
        const { tabId } = request.params as { tabId: string };
        const tab = await app.terminalService.closeTab(tabId);
        if (!tab) {
            return reply.code(404).send({ error: "Terminal tab not found" });
        }
        await app.filesystemService.cleanupTerminalDropFiles(tab.sessionId);
        app.workspaceEventHub.emit("terminal.tab.closed", { worktreeId: tab.worktreeId });
        return reply.code(204).send();
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

    // Unauthenticated by design: a terminal-hosted agent CLI's shell hook posts
    // here. It can only move a status badge, and reusing an auth secret would
    // leak it into every agent shell's env. Guarded by 127.0.0.1 bind + a
    // sessionId existence check + never erroring the caller.
    app.post("/terminal/agent-hook", async (request, reply) => {
        const parsed = TerminalAgentHookEventSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            return reply.code(204).send();
        }
        const { sessionId, eventType, toolName, permissionMode, agent } = parsed.data;
        // Live PTY or a persisted terminal tab (hooks can outlive a brief reconnect).
        if (!(await app.terminalService.isKnownAgentHookSession(sessionId))) {
            return reply.code(204).send();
        }

        const next = mapTerminalAgentEvent(
            { eventType, toolName, permissionMode, agent },
            app.terminalService.getAgentStatus(sessionId),
        );
        if (app.terminalService.setAgentStatus(sessionId, next)) {
            const worktreeId = sessionId.includes(":") ? sessionId.split(":", 1)[0] : null;
            app.workspaceEventHub.emit("terminal.agent.status", {
                worktreeId,
                terminalSessionId: sessionId,
                terminalAgentStatus: next,
            });
        }
        return reply.code(204).send();
    });

    app.get("/terminal/agent-status", async (_request, reply) => {
        return reply.send({ data: app.terminalService.listAgentStatuses() });
    });

    app.get(
        "/terminal/ws",
        { websocket: true },
        (socket, request) => {
            handleTerminalWebSocket(app, socket, { query: request.query as Record<string, string> });
        },
    );
}
