import { type FastifyInstance } from "fastify";
import { appendFileSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PATH = join(process.cwd(), "debug.log");

// Clear log file on startup
writeFileSync(LOG_PATH, "", "utf-8");

type RuntimeDatabaseInfo = {
  urlKind: "missing" | "file" | "non-file";
  resolvedPath: string | null;
  urlPreview: string | null;
};

const defaultSchemaPath = path.resolve(fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url)));

function getPrismaSchemaDirectory(): string {
  const schemaPath = process.env.PRISMA_SCHEMA_PATH;
  if (schemaPath && schemaPath.trim().length > 0) {
    return path.dirname(path.resolve(schemaPath));
  }

  return path.dirname(defaultSchemaPath);
}

export type DebugLogPayload = {
  source: string;
  message: string;
  data?: unknown;
};

export function appendDebugLogEntries(entries: Array<{
  seq: number;
  ts: number;
  source: string;
  message: string;
  data: unknown;
}>): number {
  if (entries.length === 0) {
    return 0;
  }

  const lines = entries
    .map(
      (e) =>
        `#${e.seq} [${e.ts.toFixed(1)}ms] ${e.source} | ${e.message} | ${JSON.stringify(e.data)}`,
    )
    .join("\n");

  appendFileSync(LOG_PATH, lines + "\n", "utf-8");
  return entries.length;
}

let runtimeDebugSeq = 0;

export function appendRuntimeDebugLog(entry: DebugLogPayload): number {
  const seq = ++runtimeDebugSeq;
  appendDebugLogEntries([
    {
      seq,
      ts: Number(process.uptime().toFixed(3)) * 1000,
      source: entry.source,
      message: entry.message,
      data: entry.data ?? null,
    },
  ]);
  return seq;
}

export function resolveDatabaseInfo(databaseUrl: string | undefined): RuntimeDatabaseInfo {
  if (!databaseUrl) {
    return { urlKind: "missing", resolvedPath: null, urlPreview: null };
  }

  if (!databaseUrl.startsWith("file:")) {
    const scheme = databaseUrl.split(":")[0]?.trim() || "unknown";
    return { urlKind: "non-file", resolvedPath: null, urlPreview: `${scheme}:<redacted>` };
  }

  const rawPath = databaseUrl.slice("file:".length).split("?")[0]?.split("#")[0] ?? "";
  if (rawPath === ":memory:") {
    return { urlKind: "file", resolvedPath: ":memory:", urlPreview: "file::memory:" };
  }

  const normalizedRawPath = rawPath.startsWith("//") ? rawPath.slice(2) : rawPath;
  const resolvedPath = path.isAbsolute(normalizedRawPath)
    ? path.normalize(normalizedRawPath)
    : path.resolve(getPrismaSchemaDirectory(), normalizedRawPath);

  return {
    urlKind: "file",
    resolvedPath,
    urlPreview: `file:${rawPath}`,
  };
}

export async function registerDebugRoutes(app: FastifyInstance) {
  // Accept both application/json and text/plain (sendBeacon sends text/plain)
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error);
      }
    },
  );

  app.post("/debug/log", async (request, reply) => {
    const entries = request.body as Array<{
      seq: number;
      ts: number;
      source: string;
      message: string;
      data: unknown;
    }>;

    if (!Array.isArray(entries)) {
      return reply.code(400).send({ error: "Expected array" });
    }

    appendDebugLogEntries(entries);

    return { ok: true, count: entries.length };
  });

  app.get("/debug/runtime-info", async () => {
    const address = app.server.address();
    const listenAddress = typeof address === "string"
      ? { kind: "pipe" as const, value: address }
      : address
        ? { kind: "tcp" as const, value: address.address, family: address.family, port: address.port }
        : null;
    const database = resolveDatabaseInfo(process.env.DATABASE_URL);

    return {
      data: {
        pid: process.pid,
        cwd: process.cwd(),
        nodeVersion: process.version,
        runtimeHost: process.env.RUNTIME_HOST ?? null,
        runtimePort: Number(process.env.RUNTIME_PORT ?? 0) || null,
        uptimeSec: Number(process.uptime().toFixed(1)),
        database,
        listenAddress,
      },
    };
  });
}
