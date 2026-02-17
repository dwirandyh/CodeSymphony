import type { FastifyInstance } from "fastify";

export async function registerTerminalRoutes(app: FastifyInstance) {
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
