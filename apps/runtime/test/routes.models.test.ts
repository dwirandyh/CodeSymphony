import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as claudeModelCatalog from "../src/claude/modelCatalog.js";
import * as codexSessionRunner from "../src/codex/sessionRunner.js";
import * as cursorSessionRunner from "../src/cursor/sessionRunner.js";
import * as opencodeModelCatalog from "../src/opencode/modelCatalog.js";
import { registerModelRoutes } from "../src/routes/models";

describe("model provider routes", () => {
  let app: FastifyInstance;
  let modelCatalogCacheDir: string;
  const mockService = {
    listProviders: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    createModel: vi.fn(),
    deleteModel: vi.fn(),
    resolveProviderSelection: vi.fn(),
  };

  async function createTestApp(): Promise<FastifyInstance> {
    const nextApp = Fastify({ logger: false });
    nextApp.decorate("modelProviderService", mockService as never);
    await nextApp.register(registerModelRoutes, { prefix: "/api" });
    await nextApp.ready();
    return nextApp;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    modelCatalogCacheDir = await mkdtemp(path.join(os.tmpdir(), "codesymphony-model-catalog-cache-"));
    process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR = modelCatalogCacheDir;
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR;
    await rm(modelCatalogCacheDir, { recursive: true, force: true });
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

  it("GET /api/claude/models lists the Claude catalog with display metadata", async () => {
    vi.spyOn(claudeModelCatalog, "listClaudeModels")
      .mockResolvedValue([
        {
          id: "default",
          name: "Default (recommended)",
          description: "Use the default model.",
        },
        {
          id: "opus",
          name: "Opus",
          description: "Most capable for complex work.",
        },
      ]);
    const res = await app.inject({ method: "GET", url: "/api/claude/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.models).toEqual([
      {
        id: "default",
        name: "Default (recommended)",
        description: "Use the default model.",
      },
      {
        id: "opus",
        name: "Opus",
        description: "Most capable for complex work.",
      },
    ]);
    expect(typeof res.json().data.fetchedAt).toBe("string");
  });

  it("GET /api/codex/models lists the Codex model catalog with display metadata", async () => {
    vi.spyOn(codexSessionRunner, "listCodexModels")
      .mockResolvedValue([
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: "Frontier coding model",
          hidden: false,
          isDefault: true,
        },
        {
          id: "gpt-5.4",
          name: "gpt-5.4",
          description: "Strong model for everyday coding.",
          hidden: false,
          isDefault: false,
        },
      ]);
    const res = await app.inject({ method: "GET", url: "/api/codex/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.models).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        description: "Frontier coding model",
        hidden: false,
        isDefault: true,
      },
      {
        id: "gpt-5.4",
        name: "gpt-5.4",
        description: "Strong model for everyday coding.",
        hidden: false,
        isDefault: false,
      },
    ]);
    expect(typeof res.json().data.fetchedAt).toBe("string");
  });

  it("GET /api/codex/models reuses the cached catalog until it expires", async () => {
    const listCodexModels = vi.spyOn(codexSessionRunner, "listCodexModels")
      .mockResolvedValue([
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: "Frontier coding model",
          hidden: false,
          isDefault: true,
        },
      ]);

    const first = await app.inject({ method: "GET", url: "/api/codex/models" });
    const second = await app.inject({ method: "GET", url: "/api/codex/models" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(listCodexModels).toHaveBeenCalledTimes(1);
    expect(second.json().data).toEqual(first.json().data);
  });

  it("GET /api/codex/models reuses the persisted catalog after the runtime restarts", async () => {
    const listCodexModels = vi.spyOn(codexSessionRunner, "listCodexModels")
      .mockResolvedValue([
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: "Frontier coding model",
          hidden: false,
          isDefault: true,
        },
      ]);

    const first = await app.inject({ method: "GET", url: "/api/codex/models" });
    expect(first.statusCode).toBe(200);
    expect(listCodexModels).toHaveBeenCalledTimes(1);

    await app.close();
    app = await createTestApp();

    listCodexModels.mockResolvedValue([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        description: "Fallback model",
        hidden: false,
        isDefault: false,
      },
    ]);

    const second = await app.inject({ method: "GET", url: "/api/codex/models" });

    expect(second.statusCode).toBe(200);
    expect(listCodexModels).toHaveBeenCalledTimes(1);
    expect(second.json().data).toEqual(first.json().data);
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

  it("GET /api/model-capabilities hides reasoning effort for Cursor models without reasoning metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/model-capabilities?agent=cursor&model=composer-2.5%5Bfast%3Dtrue%5D",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.optionDescriptors.map((descriptor: { id: string }) => descriptor.id)).toEqual([]);
  });

  it("GET /api/model-capabilities derives Cursor option defaults from the selected model metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/model-capabilities?agent=cursor&model=gpt-5.5%5Bcontext%3D272k%2Creasoning%3Dhigh%2Cfast%3Dtrue%5D",
    });

    expect(res.statusCode).toBe(200);
    const descriptors = res.json().data.optionDescriptors;
    expect(descriptors.find((descriptor: { id: string }) => descriptor.id === "reasoningEffort")).toMatchObject({
      id: "reasoningEffort",
      currentValue: "high",
    });
    expect(descriptors.find((descriptor: { id: string }) => descriptor.id === "fastMode")).toMatchObject({
      id: "fastMode",
      currentValue: true,
    });
  });

  it("POST /api/model-providers creates provider", async () => {
    mockService.createProvider.mockResolvedValue({ id: "p1", name: "New" });
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers",
      payload: {
        name: "New",
        compatibility: "openai",
        baseUrl: "http://localhost",
        apiKey: "key",
        models: [{ modelId: "m1" }],
      },
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

  it("POST /api/model-providers/:id/models creates model", async () => {
    mockService.createModel.mockResolvedValue({ id: "p1", name: "Provider" });
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/p1/models",
      payload: { modelId: "m2" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockService.createModel).toHaveBeenCalledWith("p1", { modelId: "m2" });
  });

  it("DELETE /api/model-provider-models/:id deletes model", async () => {
    mockService.deleteModel.mockResolvedValue(undefined);
    const res = await app.inject({ method: "DELETE", url: "/api/model-provider-models/m1" });
    expect(res.statusCode).toBe(204);
  });

  it("POST /api/model-providers/test handles fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        compatibility: "anthropic",
        baseUrl: "http://localhost:9999",
        apiKey: "key",
        modelId: "model",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(false);
    expect(res.json().data.error).toContain("Connection refused");
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test resolves a saved provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    mockService.resolveProviderSelection.mockResolvedValue({
      id: "p1",
      compatibility: "anthropic",
      baseUrl: "http://localhost:9999/",
      apiKey: "key",
      name: "Provider",
      modelId: "model",
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        providerId: "p1",
        modelId: "model",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
    expect(mockService.resolveProviderSelection).toHaveBeenCalledWith("p1", "model");
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test fails when the saved provider model is missing", async () => {
    const fetchMock = vi.fn();
    mockService.resolveProviderSelection.mockRejectedValue(new Error("Selected model is no longer available in this provider"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        providerId: "p1",
        modelId: "deleted-model",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      success: false,
      error: "Selected model is no longer available in this provider",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test handles successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        compatibility: "anthropic",
        baseUrl: "http://localhost:9999/",
        apiKey: "key",
        modelId: "model",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test uses the responses API contract for OpenAI-compatible providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        compatibility: "openai",
        baseUrl: "http://localhost:9999/v1",
        apiKey: "key",
        modelId: "gpt-5.4",
      },
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

  it("POST /api/model-providers/test uses the responses API contract for custom OpenAI-compatible model ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        compatibility: "openai",
        baseUrl: "http://localhost:9999/v1",
        apiKey: "key",
        modelId: "gpt-5-custom",
      },
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

  it("POST /api/model-providers/test explains when an OpenAI-compatible endpoint only supports chat completions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue("{\"error\":\"not found\"}"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        compatibility: "openai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKey: "key",
        modelId: "GLM-4.7",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      success: false,
      error: "This endpoint supports OpenAI Chat Completions, but Codex requires the OpenAI Responses API. It can work in OpenCode, but not in Codex.",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.z.ai/api/paas/v4/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "GLM-4.7",
          input: "Hi",
          max_output_tokens: 1,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.z.ai/api/paas/v4/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "GLM-4.7",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("POST /api/model-providers/test explains when chat completions exists but is currently rate limited", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue("{\"error\":\"not found\"}"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: vi.fn().mockResolvedValue("{\"error\":{\"message\":\"Insufficient balance\"}}"),
      });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({
      method: "POST",
      url: "/api/model-providers/test",
      payload: {
        compatibility: "openai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKey: "key",
        modelId: "GLM-4.7",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      success: false,
      error: "This endpoint appears to support OpenAI Chat Completions but not the Responses API. Chat Completions returned 429: {\"error\":{\"message\":\"Insufficient balance\"}}. It can work in OpenCode, but not in Codex.",
    });
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
      payload: {
        compatibility: "anthropic",
        baseUrl: "http://localhost:9999",
        apiKey: "bad",
        modelId: "model",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(false);
    expect(res.json().data.error).toContain("401");
    vi.unstubAllGlobals();
  });
});
