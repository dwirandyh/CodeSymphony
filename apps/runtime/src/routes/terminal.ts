import type { FastifyInstance } from "fastify";
import { z } from "zod";

const runTerminalInputSchema = z.object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
});
const interruptTerminalInputSchema = z.object({
    sessionId: z.string().min(1),
});

export async function registerTerminalRoutes(app: FastifyInstance) {
    app.post("/terminal/run", async (request, reply) => {
        try {
            const input = runTerminalInputSchema.parse(request.body ?? {});
            app.terminalService.spawn(input.sessionId, input.cwd);
            app.terminalService.write(input.sessionId, `${input.command}\r`);
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

    app.get(
        "/terminal/ws",
        { websocket: true },
        (socket, request) => {
            const query = request.query as Record<string, string>;
            const sessionId = query.sessionId || "default";
            const cwd = query.cwd || undefined;

            try {
                app.terminalService.spawn(sessionId, cwd);
            } catch (spawnError) {
                const message = spawnError instanceof Error ? spawnError.message : "Failed to spawn terminal";
                app.logService.log("error", "terminal", `Failed to spawn PTY: ${message}`);
                socket.close(1011, message);
                return;
            }

            app.logService.log("info", "terminal", `Terminal session connected: ${sessionId}`, { cwd });

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
            );

            socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
                const message = raw.toString();

                try {
                    const parsed = JSON.parse(message) as Record<string, unknown>;
                    if (parsed.type === "resize") {
                        const cols = Number(parsed.cols) || 80;
                        const rows = Number(parsed.rows) || 24;
                        app.terminalService.resize(sessionId, cols, rows);
                        return;
                    }
                } catch {
                    // Not JSON — treat as raw terminal input
                }

                app.terminalService.write(sessionId, message);
            });

            socket.on("close", () => {
                removeListener();
                app.logService.log("info", "terminal", `Terminal session disconnected: ${sessionId}`);
            });

            socket.on("error", (error: Error) => {
                app.logService.log("error", "terminal", `Terminal WebSocket error: ${error.message}`);
                removeListener();
            });
        },
    );
}
