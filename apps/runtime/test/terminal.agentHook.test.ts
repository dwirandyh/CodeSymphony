import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalAgentStatus } from "@codesymphony/shared-types";
import { registerTerminalRoutes } from "../src/routes/terminal";

function createFakeTerminalService() {
  const statuses = new Map<string, TerminalAgentStatus>();
  const known = new Set<string>();
  const knownTabs = new Set<string>();
  return {
    has: vi.fn((sessionId: string) => known.has(sessionId)),
    isKnownAgentHookSession: vi.fn(async (sessionId: string) => known.has(sessionId) || knownTabs.has(sessionId)),
    getAgentStatus: vi.fn((sessionId: string) => statuses.get(sessionId)),
    setAgentStatus: vi.fn((sessionId: string, status: TerminalAgentStatus) => {
      if (statuses.get(sessionId) === status) return false;
      statuses.set(sessionId, status);
      return true;
    }),
    listAgentStatuses: vi.fn(() =>
      [...statuses.entries()].map(([sessionId, status]) => ({ sessionId, status })),
    ),
    __addKnown: (sessionId: string) => known.add(sessionId),
    __addKnownTab: (sessionId: string) => knownTabs.add(sessionId),
    __statuses: statuses,
  };
}

describe("POST /terminal/agent-hook", () => {
  let app: FastifyInstance;
  let terminalService: ReturnType<typeof createFakeTerminalService>;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    terminalService = createFakeTerminalService();
    terminalService.__addKnown("wt1:terminal:abc");
    emit = vi.fn();
    app = Fastify();
    app.decorate("terminalService", terminalService as never);
    app.decorate("workspaceEventHub", { emit, subscribe: vi.fn() } as never);
    app.decorate("logService", { log: vi.fn() } as never);
    app.decorate("filesystemService", { cleanupTerminalDropFiles: vi.fn() } as never);
    await app.register(registerTerminalRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("stores status and emits once for a valid event", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/terminal/agent-hook",
      payload: { sessionId: "wt1:terminal:abc", eventType: "UserPromptSubmit", agent: "claude" },
    });
    expect(res.statusCode).toBe(204);
    expect(terminalService.__statuses.get("wt1:terminal:abc")).toBe("running");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "terminal.agent.status",
      expect.objectContaining({
        terminalSessionId: "wt1:terminal:abc",
        terminalAgentStatus: "running",
        worktreeId: "wt1",
      }),
    );
  });

  it("does not emit again when status is unchanged", async () => {
    const payload = { sessionId: "wt1:terminal:abc", eventType: "UserPromptSubmit", agent: "claude" };
    await app.inject({ method: "POST", url: "/terminal/agent-hook", payload });
    emit.mockClear();
    await app.inject({ method: "POST", url: "/terminal/agent-hook", payload });
    expect(emit).not.toHaveBeenCalled();
  });

  it("returns 204 without emitting for an unknown session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/terminal/agent-hook",
      payload: { sessionId: "ghost", eventType: "UserPromptSubmit", agent: "claude" },
    });
    expect(res.statusCode).toBe(204);
    expect(emit).not.toHaveBeenCalled();
  });

  it("accepts hooks for a persisted terminal tab even when the PTY is not live", async () => {
    terminalService.__addKnownTab("wt1:terminal:tab-only");
    const res = await app.inject({
      method: "POST",
      url: "/terminal/agent-hook",
      payload: { sessionId: "wt1:terminal:tab-only", eventType: "UserPromptSubmit", agent: "claude" },
    });
    expect(res.statusCode).toBe(204);
    expect(terminalService.__statuses.get("wt1:terminal:tab-only")).toBe("running");
    expect(emit).toHaveBeenCalledWith(
      "terminal.agent.status",
      expect.objectContaining({
        terminalSessionId: "wt1:terminal:tab-only",
        terminalAgentStatus: "running",
        worktreeId: "wt1",
      }),
    );
  });

  it("returns 204 without throwing for a malformed body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/terminal/agent-hook",
      payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(204);
    expect(emit).not.toHaveBeenCalled();
  });

  it("exposes the current statuses via GET /terminal/agent-status", async () => {
    await app.inject({
      method: "POST",
      url: "/terminal/agent-hook",
      payload: { sessionId: "wt1:terminal:abc", eventType: "Notification", agent: "claude" },
    });
    const res = await app.inject({ method: "GET", url: "/terminal/agent-status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [{ sessionId: "wt1:terminal:abc", status: "waiting_approval" }],
    });
  });
});
