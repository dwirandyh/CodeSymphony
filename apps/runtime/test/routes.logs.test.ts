import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLogRoutes, normalizeClientLogEntry } from "../src/routes/logs";

describe("normalizeClientLogEntry", () => {
  it("normalizes a valid entry", () => {
    const entry = {
      id: "log-1",
      timestamp: "2026-01-01T00:00:00Z",
      level: "info" as const,
      source: "myComponent",
      message: "Hello",
    };
    const result = normalizeClientLogEntry(entry);
    expect(result.source).toBe("web.myComponent");
    expect(result.message).toBe("Hello");
    expect(result.id).toBe("log-1");
  });

  it("preserves web. prefix in source", () => {
    const entry = {
      id: "log-2",
      timestamp: "2026-01-01T00:00:00Z",
      level: "debug" as const,
      source: "web.existing",
      message: "test",
    };
    const result = normalizeClientLogEntry(entry);
    expect(result.source).toBe("web.existing");
  });

  it("truncates long messages", () => {
    const entry = {
      id: "log-3",
      timestamp: "2026-01-01T00:00:00Z",
      level: "warn" as const,
      source: "src",
      message: "x".repeat(2000),
    };
    const result = normalizeClientLogEntry(entry);
    expect(result.message.length).toBe(1000);
  });

  it("normalizes invalid timestamp to nowIso", () => {
    const entry = {
      id: "log-4",
      timestamp: "not-a-date",
      level: "error" as const,
      source: "src",
      message: "msg",
    };
    const nowIso = "2026-06-01T12:00:00.000Z";
    const result = normalizeClientLogEntry(entry, nowIso);
    expect(result.timestamp).toBe(nowIso);
  });

  it("includes data when present", () => {
    const entry = {
      id: "log-5",
      timestamp: "2026-01-01T00:00:00Z",
      level: "info" as const,
      source: "src",
      message: "msg",
      data: { key: "value" },
    };
    const result = normalizeClientLogEntry(entry);
    expect(result.data).toEqual({ key: "value" });
  });
});

describe("log routes", () => {
  let app: FastifyInstance;

  const mockLogService = {
    getEntries: vi.fn(),
    ingest: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    log: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("logService", mockLogService as never);
    await app.register(registerLogRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/logs", () => {
    it("returns log entries", async () => {
      mockLogService.getEntries.mockReturnValue([{ id: "l1", message: "test" }]);
      const res = await app.inject({ method: "GET", url: "/api/logs" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
    });

    it("passes since query param", async () => {
      mockLogService.getEntries.mockReturnValue([]);
      const res = await app.inject({ method: "GET", url: "/api/logs?since=2026-01-01" });
      expect(res.statusCode).toBe(200);
      expect(mockLogService.getEntries).toHaveBeenCalledWith("2026-01-01");
    });
  });

  describe("POST /api/logs/client", () => {
    it("ingests client log batch", async () => {
      mockLogService.ingest.mockReturnValue(true);
      const res = await app.inject({
        method: "POST",
        url: "/api/logs/client",
        payload: {
          entries: [
            {
              id: "cl-1",
              timestamp: "2026-01-01T00:00:00Z",
              level: "info",
              source: "chat",
              message: "test log",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.accepted).toBe(1);
    });

    it("returns 0 accepted when ingest rejects", async () => {
      mockLogService.ingest.mockReturnValue(false);
      const res = await app.inject({
        method: "POST",
        url: "/api/logs/client",
        payload: {
          entries: [
            {
              id: "cl-2",
              timestamp: "2026-01-01T00:00:00Z",
              level: "error",
              source: "web.ui",
              message: "failed",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.accepted).toBe(0);
    });

    it("returns 500 for invalid payload (Zod parse error)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/logs/client",
        payload: { entries: [{ invalid: true }] },
      });
      expect(res.statusCode).toBe(500);
    });
  });
});
