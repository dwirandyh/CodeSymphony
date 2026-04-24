import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cursorSessionRunner from "../src/cursor/sessionRunner.js";
import * as opencodeModelCatalog from "../src/opencode/modelCatalog.js";
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

  it("GET /api/opencode/models lists the OpenCode catalog with display metadata", async () => {
    vi.spyOn(opencodeModelCatalog, "listOpencodeModels")
      .mockResolvedValue([
        {
          id: "opencode/minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          providerId: "opencode",
        },
        {
          id: "zai/glm-4.7-flash",
          name: "GLM-4.7-Flash",
          providerId: "zai",
        },
      ]);
    const res = await app.inject({ method: "GET", url: "/api/opencode/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.models).toEqual([
      {
        id: "opencode/minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        providerId: "opencode",
      },
      {
        id: "zai/glm-4.7-flash",
        name: "GLM-4.7-Flash",
        providerId: "zai",
      },
    ]);
    expect(typeof res.json().data.fetchedAt).toBe("string");
  });

  it("GET /api/cursor/models lists the Cursor model catalog with display metadata", async () => {
    vi.spyOn(cursorSessionRunner, "listCursorModels")
      .mockResolvedValue([
        {
          id: "default[]",
          name: "Auto",
        },
        {
          id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
          name: "GPT-5.4",
        },
      ]);
    const res = await app.inject({ method: "GET", url: "/api/cursor/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.models).toEqual([
      {
        id: "default[]",
        name: "Auto",
      },
      {
        id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        name: "GPT-5.4",
      },
    ]);
    expect(typeof res.json().data.fetchedAt).toBe("string");
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

  it("POST /api/model-providers/test uses the responses API contract for Codex", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: { agent: "codex", baseUrl: "http://localhost:9999/v1", apiKey: "key", modelId: "gpt-5.4" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9999/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "Hi",
          max_output_tokens: 1,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test uses the responses API contract for OpenCode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: { agent: "opencode", baseUrl: "http://localhost:9999/v1", apiKey: "key", modelId: "gpt-5-custom" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9999/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model: "gpt-5-custom",
          input: "Hi",
          max_output_tokens: 1,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test rejects Cursor custom provider tests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: { agent: "cursor", baseUrl: "http://localhost:9999", apiKey: "key", modelId: "default[]" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Cursor does not support custom model providers");
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
