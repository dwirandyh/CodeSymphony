import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { registerDebugRoutes } from "../src/routes/debug";

describe("debug routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(registerDebugRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /api/debug/log", () => {
    it("accepts array of debug entries", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/debug/log",
        payload: [
          { seq: 1, ts: 100.5, source: "test", message: "hello", data: null },
          { seq: 2, ts: 200.0, source: "test", message: "world", data: { key: "val" } },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBe(2);
    });

    it("returns 400 for non-array body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/debug/log",
        payload: { not: "array" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/debug/runtime-info", () => {
    it("returns runtime info", async () => {
      const res = await app.inject({ method: "GET", url: "/api/debug/runtime-info" });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.pid).toBe(process.pid);
      expect(data.cwd).toBe(process.cwd());
      expect(data.nodeVersion).toBe(process.version);
      expect(data).toHaveProperty("database");
      expect(data).toHaveProperty("listenAddress");
    });
  });
});
