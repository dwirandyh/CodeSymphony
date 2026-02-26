import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LogEntry } from "../services/logService.js";

const MAX_CLIENT_LOG_BATCH = 100;
const MAX_CLIENT_MESSAGE_CHARS = 1000;

const ClientLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const ClientLogEntrySchema = z.object({
    id: z.string().trim().min(1),
    timestamp: z.string(),
    level: ClientLogLevelSchema,
    source: z.string().trim().min(1),
    message: z.string(),
    data: z.unknown().optional(),
});
const ClientLogBatchSchema = z.object({
    entries: z.array(ClientLogEntrySchema).max(MAX_CLIENT_LOG_BATCH),
});

type ClientLogEntry = z.infer<typeof ClientLogEntrySchema>;

function normalizeSource(source: string): string {
    const normalized = source.trim();
    return normalized.startsWith("web.") ? normalized : `web.${normalized}`;
}

function normalizeMessage(message: string): string {
    const normalized = message.trim();
    if (normalized.length <= MAX_CLIENT_MESSAGE_CHARS) {
        return normalized;
    }

    return normalized.slice(0, MAX_CLIENT_MESSAGE_CHARS);
}

function normalizeTimestamp(timestamp: string, nowIso = new Date().toISOString()): string {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso;
}

export function normalizeClientLogEntry(entry: ClientLogEntry, nowIso?: string): LogEntry {
    return {
        id: entry.id,
        timestamp: normalizeTimestamp(entry.timestamp, nowIso),
        level: entry.level,
        source: normalizeSource(entry.source),
        message: normalizeMessage(entry.message),
        ...(entry.data !== undefined ? { data: entry.data } : {}),
    };
}

export const __testing = {
    ClientLogBatchSchema,
    MAX_CLIENT_LOG_BATCH,
    MAX_CLIENT_MESSAGE_CHARS,
    normalizeClientLogEntry,
};

export async function registerLogRoutes(app: FastifyInstance) {
    app.get("/logs", async (request) => {
        const query = request.query as Record<string, string>;
        const since = query.since || undefined;
        return { data: app.logService.getEntries(since) };
    });

    app.post("/logs/client", async (request) => {
        const input = ClientLogBatchSchema.parse(request.body ?? {});
        const nowIso = new Date().toISOString();

        let accepted = 0;
        for (const rawEntry of input.entries) {
            const normalized = normalizeClientLogEntry(rawEntry, nowIso);
            if (app.logService.ingest(normalized)) {
                accepted += 1;
            }
        }

        return { data: { accepted } };
    });

    app.get("/logs/stream", async (request, reply) => {
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });

        reply.raw.write(":\n\n");

        const unsubscribe = app.logService.subscribe((entry) => {
            reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
        });

        request.raw.on("close", () => {
            unsubscribe();
        });
    });
}
