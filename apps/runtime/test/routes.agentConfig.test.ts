import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listCursorSdkModels = vi.fn();
const spawnSync = vi.fn();

vi.mock("../src/cursor/sdk/catalog.js", () => ({
  listCursorSdkModels: (params: unknown) => listCursorSdkModels(params),
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args),
}));

const { registerAgentConfigRoutes } = await import("../src/routes/agentConfig");

describe("agent config routes", () => {
  let app: FastifyInstance;
  const getAgentConfig = vi.fn();
  const updateAgentConfig = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    app.decorate("agentConfigService", { getAgentConfig, updateAgentConfig } as never);
    await app.register(registerAgentConfigRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/settings/agents returns masked config", async () => {
    getAgentConfig.mockResolvedValue({
      claudePath: "/bin/claude",
      codexPath: null,
      opencodePath: null,
      cursorApiKeyMasked: "key-abc...7890",
      cursorApiKeySet: true,
      updatedAt: "2026-06-15T00:00:00.000Z",
    });
    const res = await app.inject({ method: "GET", url: "/api/settings/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.cursorApiKeyMasked).toBe("key-abc...7890");
    expect(res.json().data).not.toHaveProperty("cursorApiKey");
  });

  it("PUT /api/settings/agents round-trips and returns masked response", async () => {
    updateAgentConfig.mockResolvedValue({
      claudePath: "/bin/claude",
      codexPath: null,
      opencodePath: null,
      cursorApiKeyMasked: "cursor-...7890",
      cursorApiKeySet: true,
      updatedAt: "2026-06-15T00:00:00.000Z",
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/agents",
      payload: { claudePath: "/bin/claude", cursorApiKey: "cursor-secret-7890" },
    });
    expect(res.statusCode).toBe(200);
    expect(updateAgentConfig).toHaveBeenCalledWith({
      claudePath: "/bin/claude",
      cursorApiKey: "cursor-secret-7890",
    });
    expect(res.json().data.cursorApiKeyMasked).toBe("cursor-...7890");
    expect(res.json().data).not.toHaveProperty("cursorApiKey");
  });

  it("POST test for a path agent returns ok with version detail", async () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "codex 1.2.3\n", stderr: "" });
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/agents/test",
      payload: { agent: "codex", value: "/bin/codex" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true, detail: "codex 1.2.3" });
    expect(spawnSync).toHaveBeenCalledWith("/bin/codex", ["--version"], expect.anything());
  });

  it("POST test for a path agent returns error when binary fails", async () => {
    spawnSync.mockReturnValue({ status: 127, stdout: "", stderr: "not found" });
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/agents/test",
      payload: { agent: "claude", value: "/bad/claude" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(false);
    expect(res.json().data.error).toContain("not found");
  });

  it("POST test for cursor validates the API key", async () => {
    listCursorSdkModels.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/agents/test",
      payload: { agent: "cursor", value: "cursor-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(listCursorSdkModels).toHaveBeenCalledWith({ apiKey: "cursor-key" });
  });

  it("POST test for cursor reports invalid key", async () => {
    listCursorSdkModels.mockRejectedValue(new Error("unauthorized"));
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/agents/test",
      payload: { agent: "cursor", value: "bad-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.ok).toBe(false);
    expect(res.json().data.error).toContain("unauthorized");
  });
});
