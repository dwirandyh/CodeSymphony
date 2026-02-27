import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDebugRoutes } from "../src/routes/debug";

describe("GET /api/debug/runtime-info", () => {
  let app: FastifyInstance;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRuntimePort = process.env.RUNTIME_PORT;
  const originalRuntimeHost = process.env.RUNTIME_HOST;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(registerDebugRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.RUNTIME_PORT = originalRuntimePort;
    process.env.RUNTIME_HOST = originalRuntimeHost;
  });

  it("returns process identity and resolved file database path", async () => {
    process.env.RUNTIME_HOST = "0.0.0.0";
    process.env.RUNTIME_PORT = "4331";
    process.env.DATABASE_URL = "file:./prisma/dev.db";

    const response = await app.inject({
      method: "GET",
      url: "/api/debug/runtime-info",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      data: {
        pid: number;
        cwd: string;
        runtimeHost: string | null;
        runtimePort: number | null;
        database: { urlKind: string; resolvedPath: string | null; urlPreview: string | null };
      };
    };

    expect(payload.data.pid).toBe(process.pid);
    expect(payload.data.cwd).toBe(process.cwd());
    expect(payload.data.runtimeHost).toBe("0.0.0.0");
    expect(payload.data.runtimePort).toBe(4331);
    expect(payload.data.database.urlKind).toBe("file");
    expect(payload.data.database.resolvedPath).toBe(path.resolve(process.cwd(), "prisma/dev.db"));
    expect(payload.data.database.urlPreview).toBe("file:./prisma/dev.db");
  });

  it("redacts non-file database URLs", async () => {
    process.env.DATABASE_URL = "postgresql://user:secret@localhost:5432/db";

    const response = await app.inject({
      method: "GET",
      url: "/api/debug/runtime-info",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      data: {
        database: { urlKind: string; resolvedPath: string | null; urlPreview: string | null };
      };
    };

    expect(payload.data.database.urlKind).toBe("non-file");
    expect(payload.data.database.resolvedPath).toBeNull();
    expect(payload.data.database.urlPreview).toBe("postgresql:<redacted>");
  });
});
