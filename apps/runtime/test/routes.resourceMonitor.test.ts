import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerResourceMonitorRoutes } from "../src/routes/resourceMonitor.js";

describe("resource monitor routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.decorate("resourceMonitorService", {
      getSnapshot: vi.fn().mockResolvedValue({
        runtime: {
          pid: 123,
          cpu: 1,
          memory: 2,
        },
        worktrees: [],
        host: {
          totalMemory: 100,
          freeMemory: 10,
          usedMemory: 90,
          memoryUsagePercent: 90,
          cpuCoreCount: 8,
          loadAverage1m: 1.2,
        },
        collectedAt: 1,
      }),
    });
    await app.register(registerResourceMonitorRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the resource monitor snapshot envelope", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/resource-monitor/snapshot",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        runtime: {
          pid: 123,
          cpu: 1,
          memory: 2,
        },
        worktrees: [],
        host: {
          totalMemory: 100,
          freeMemory: 10,
          usedMemory: 90,
          memoryUsagePercent: 90,
          cpuCoreCount: 8,
          loadAverage1m: 1.2,
        },
        collectedAt: 1,
      },
    });
  });
});
