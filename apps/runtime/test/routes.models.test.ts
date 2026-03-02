import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../src/routes/models";

describe("model provider routes", () => {
  let app: FastifyInstance;
  const mockService = {
    listProviders: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    activateProvider: vi.fn(),
    deactivateAll: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("modelProviderService", mockService as never);
    await app.register(registerModelRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/model-providers lists providers", async () => {
    mockService.listProviders.mockResolvedValue([{ id: "p1", name: "Test" }]);
    const res = await app.inject({ method: "GET", url: "/api/model-providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: "p1", name: "Test" }]);
  });

  it("POST /api/model-providers creates provider", async () => {
    mockService.createProvider.mockResolvedValue({ id: "p1", name: "New" });
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: { name: "New", modelId: "m1", baseUrl: "http://localhost", apiKey: "key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("New");
  });

  it("PATCH /api/model-providers/:id updates provider", async () => {
    mockService.updateProvider.mockResolvedValue({ id: "p1", name: "Updated" });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/model-providers/p1",
      payload: { name: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("Updated");
  });

  it("DELETE /api/model-providers/:id deletes provider", async () => {
    mockService.deleteProvider.mockResolvedValue(undefined);
    const res = await app.inject({ method: "DELETE", url: "/api/model-providers/p1" });
    expect(res.statusCode).toBe(204);
  });

  it("POST /api/model-providers/:id/activate activates provider", async () => {
    mockService.activateProvider.mockResolvedValue({ id: "p1", isActive: true });
    const res = await app.inject({ method: "POST", url: "/api/model-providers/p1/activate" });
    expect(res.statusCode).toBe(200);
  });

  it("POST /api/model-providers/deactivate deactivates all", async () => {
    mockService.deactivateAll.mockResolvedValue(undefined);
    const res = await app.inject({ method: "POST", url: "/api/model-providers/deactivate" });
    expect(res.statusCode).toBe(204);
  });

  it("POST /api/model-providers/test handles fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: { baseUrl: "http://localhost:9999", apiKey: "key", modelId: "model" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(false);
    expect(res.json().data.error).toContain("Connection refused");
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test handles successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: { baseUrl: "http://localhost:9999/", apiKey: "key", modelId: "model" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test handles non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue("Unauthorized"),
    }));
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: { baseUrl: "http://localhost:9999", apiKey: "bad", modelId: "model" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(false);
    expect(res.json().data.error).toContain("401");
    vi.unstubAllGlobals();
  });
});
