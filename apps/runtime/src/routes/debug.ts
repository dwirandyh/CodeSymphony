import { type FastifyInstance } from "fastify";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveCodexCliProviderOverride } from "../codex/config.js";

function resolveDebugLogPath(): string {
  const configuredPath = process.env.CODESYMPHONY_DEBUG_LOG_PATH?.trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.join(os.tmpdir(), "codesymphony", "debug.log");
}

const LOG_PATH = resolveDebugLogPath();
const LOG_DIR = path.dirname(LOG_PATH);

try {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!existsSync(LOG_PATH)) {
    writeFileSync(LOG_PATH, "", "utf-8");
  }
  appendFileSync(
    LOG_PATH,
    `\n=== runtime session started ${new Date().toISOString()} pid=${process.pid} cwd=${process.cwd()} execPath=${process.execPath} ===\n`,
    "utf-8",
  );
} catch (error) {
  console.error(`Failed to initialize debug log at ${LOG_PATH}:`, error);
}

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

type DebugLogPayload = {
  source: string;
  message: string;
  data?: unknown;
};

type DebugLogEntry = {
  seq: number;
  ts: number;
  source: string;
  message: string;
  data: unknown;
};

const DEBUG_LOG_BUFFER_LIMIT = 4000;
const runtimeDebugBuffer: DebugLogEntry[] = [];
let lastDebugLogAppendError: string | null = null;

function appendDebugLogEntries(entries: DebugLogEntry[]): number {
  if (entries.length === 0) {
    return 0;
  }

  runtimeDebugBuffer.push(...entries);
  if (runtimeDebugBuffer.length > DEBUG_LOG_BUFFER_LIMIT) {
    runtimeDebugBuffer.splice(0, runtimeDebugBuffer.length - DEBUG_LOG_BUFFER_LIMIT);
  }

  const lines = entries
    .map(
      (e) =>
        `#${e.seq} [${e.ts.toFixed(1)}ms] ${e.source} | ${e.message} | ${JSON.stringify(e.data)}`,
    )
    .join("\n");

  try {
    appendFileSync(LOG_PATH, lines + "\n", "utf-8");
    lastDebugLogAppendError = null;
  } catch (error) {
    lastDebugLogAppendError = error instanceof Error ? error.message : String(error);
    console.error(`Failed to append debug log at ${LOG_PATH}:`, error);
  }
  return entries.length;
}

let runtimeDebugSeq = 0;

function parseCsvFilter(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function extractThreadIdFromDebugData(data: unknown): string | null {
  if (
    data != null
    && typeof data === "object"
    && "threadId" in data
    && typeof (data as Record<string, unknown>).threadId === "string"
  ) {
    const threadId = ((data as Record<string, unknown>).threadId as string).trim();
    return threadId.length > 0 ? threadId : null;
  }

  return null;
}

function matchesSourcePrefixes(source: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) {
    return true;
  }

  return prefixes.some((prefix) => source === prefix || source.startsWith(`${prefix}.`));
}

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
  const debugLogBufferQuery = z.object({
    limit: z.string().optional(),
    source: z.string().optional(),
    message: z.string().optional(),
    threadId: z.string().optional(),
  }).strict();

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

  app.get("/debug/log-buffer", async (request) => {
    const query = debugLogBufferQuery.parse(request.query);
    const parsedLimit = Number.parseInt(query.limit ?? "", 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, DEBUG_LOG_BUFFER_LIMIT)
      : 500;
    const sourcePrefixes = parseCsvFilter(query.source);
    const messageNeedle = query.message?.trim().toLowerCase() ?? "";
    const threadIdFilter = query.threadId?.trim() ?? "";
    const filteredEntries = runtimeDebugBuffer.filter((entry) => {
      if (!matchesSourcePrefixes(entry.source, sourcePrefixes)) {
        return false;
      }

      if (messageNeedle.length > 0 && !entry.message.toLowerCase().includes(messageNeedle)) {
        return false;
      }

      if (threadIdFilter.length > 0 && extractThreadIdFromDebugData(entry.data) !== threadIdFilter) {
        return false;
      }

      return true;
    });

    return {
      data: {
        logPath: LOG_PATH,
        totalBufferedEntries: runtimeDebugBuffer.length,
        lastAppendError: lastDebugLogAppendError,
        filteredEntries: filteredEntries.length,
        entries: filteredEntries.slice(-limit),
      },
    };
  });

  app.get("/debug/runtime-info", async () => {
    const address = app.server.address();
    const listenAddress = typeof address === "string"
      ? { kind: "pipe" as const, value: address }
      : address
        ? { kind: "tcp" as const, value: address.address, family: address.family, port: address.port }
        : null;
    const database = resolveDatabaseInfo(process.env.DATABASE_URL);
    const codexCliProviderOverride = resolveCodexCliProviderOverride();

    return {
      data: {
        pid: process.pid,
        cwd: process.cwd(),
        nodeVersion: process.version,
        runtimeHost: process.env.RUNTIME_HOST ?? null,
        runtimePort: Number(process.env.RUNTIME_PORT ?? 0) || null,
        uptimeSec: Number(process.uptime().toFixed(1)),
        debugLogPath: LOG_PATH,
        debugBufferedEntries: runtimeDebugBuffer.length,
        debugLastAppendError: lastDebugLogAppendError,
        database,
        listenAddress,
        codexCliProviderOverride,
      },
    };
  });
}
