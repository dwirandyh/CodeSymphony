import { type FastifyInstance } from "fastify";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_PATH = join(process.cwd(), "debug.log");

// Clear log file on startup
writeFileSync(LOG_PATH, "", "utf-8");

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

    const lines = entries
      .map(
        (e) =>
          `#${e.seq} [${e.ts.toFixed(1)}ms] ${e.source} | ${e.message} | ${JSON.stringify(e.data)}`,
      )
      .join("\n");

    appendFileSync(LOG_PATH, lines + "\n", "utf-8");

    return { ok: true, count: entries.length };
  });
}
