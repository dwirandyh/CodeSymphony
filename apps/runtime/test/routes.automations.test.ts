import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAutomationRoutes } from "../src/routes/automations";

describe("automation routes", () => {
  let app: FastifyInstance;

  const mockAutomationService = {
    listAutomations: vi.fn(),
    createAutomation: vi.fn(),
    getAutomation: vi.fn(),
    updateAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    runAutomationNow: vi.fn(),
    listRuns: vi.fn(),
    listPromptVersions: vi.fn(),
    restorePromptVersion: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("automationService", mockAutomationService as never);
    await app.register(registerAutomationRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists automations and forwards filters", async () => {
    mockAutomationService.listAutomations.mockResolvedValue([{ id: "automation-1" }]);

    const response = await app.inject({
      method: "GET",
      url: "/api/automations?repositoryId=repo-1&enabled=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{ id: "automation-1" }]);
    expect(mockAutomationService.listAutomations).toHaveBeenCalledWith({
      repositoryId: "repo-1",
      enabled: true,
    });
  });

  it("creates an automation", async () => {
    mockAutomationService.createAutomation.mockResolvedValue({ id: "automation-1" });

    const response = await app.inject({
      method: "POST",
      url: "/api/automations",
      payload: {
        repositoryId: "repo-1",
        targetWorktreeId: "worktree-1",
        name: "Daily audit",
        prompt: "Summarize repository issues.",
        agent: "claude",
        model: "claude-sonnet-4-6",
        modelProviderId: null,
        permissionMode: "default",
        chatMode: "default",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        timezone: "UTC",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toEqual({ id: "automation-1" });
  });

  it("returns 404 when an automation is missing", async () => {
    mockAutomationService.getAutomation.mockResolvedValue(null);

    const response = await app.inject({
      method: "GET",
      url: "/api/automations/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Automation not found");
  });

  it("updates an automation", async () => {
    mockAutomationService.updateAutomation.mockResolvedValue({
      id: "automation-1",
      enabled: false,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/automations/automation-1",
      payload: {
        enabled: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      id: "automation-1",
      enabled: false,
    });
    expect(mockAutomationService.updateAutomation).toHaveBeenCalledWith("automation-1", {
      enabled: false,
    });
  });

  it("runs an automation now", async () => {
    mockAutomationService.runAutomationNow.mockResolvedValue({
      id: "run-1",
      automationId: "automation-1",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/automations/automation-1/run",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data).toEqual({
      id: "run-1",
      automationId: "automation-1",
    });
  });

  it("lists prompt versions and restores one", async () => {
    mockAutomationService.listPromptVersions.mockResolvedValue([{ id: "version-1" }]);
    mockAutomationService.restorePromptVersion.mockResolvedValue({ id: "automation-1" });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/automations/automation-1/versions",
    });
    const restoreResponse = await app.inject({
      method: "POST",
      url: "/api/automations/automation-1/versions/version-1/restore",
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().data).toEqual([{ id: "version-1" }]);
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data).toEqual({ id: "automation-1" });
    expect(mockAutomationService.restorePromptVersion).toHaveBeenCalledWith("automation-1", "version-1");
  });
});
