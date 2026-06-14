import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeCursorSdkModule,
  fakeCursorSdkAgents,
  fakeCursorSdkCreateRequests,
  fakeCursorSdkResumeRequests,
  resetFakeCursorSdkState,
} from "./support/fakeCursorSdk.js";
import {
  acquireCursorSdkAgent,
  disposeAllCursorSdkAgents,
  isLegacyCursorAcpSessionId,
} from "../src/cursor/sdk/agentPool.js";

vi.mock("@cursor/sdk", () => FakeCursorSdkModule);

describe("Cursor SDK agent pool", () => {
  beforeEach(() => {
    resetFakeCursorSdkState();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disposeAllCursorSdkAgents();
    resetFakeCursorSdkState();
  });

  it("classifies legacy ACP session IDs", () => {
    expect(isLegacyCursorAcpSessionId("cursor-session-abc")).toBe(true);
    expect(isLegacyCursorAcpSessionId("session-abc")).toBe(true);
    expect(isLegacyCursorAcpSessionId("agent-abc")).toBe(false);
  });

  it("creates a new SDK agent for fresh sessions and emits agentId", async () => {
    const onSessionId = vi.fn();

    const lease = await acquireCursorSdkAgent({
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      model: { id: "composer-2.5" },
      onSessionId,
    });

    expect(lease.agentId).toBe("agent-1");
    expect(onSessionId).toHaveBeenCalledWith("agent-1");
    expect(fakeCursorSdkCreateRequests).toHaveLength(1);
    expect(fakeCursorSdkCreateRequests[0]).toMatchObject({
      apiKey: "cursor-key",
      model: { id: "composer-2.5" },
      local: { cwd: "/tmp/project" },
    });
    expect(fakeCursorSdkResumeRequests).toHaveLength(0);

    lease.release();
  });

  it("creates a new SDK agent for legacy ACP sessions", async () => {
    const onSessionId = vi.fn();

    const lease = await acquireCursorSdkAgent({
      sessionId: "cursor-session-old",
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      onSessionId,
    });

    expect(lease.agentId).toBe("agent-1");
    expect(onSessionId).toHaveBeenCalledWith("agent-1");
    expect(fakeCursorSdkCreateRequests).toHaveLength(1);
    expect(fakeCursorSdkResumeRequests).toHaveLength(0);

    lease.release();
  });

  it("resumes SDK agent IDs", async () => {
    const onSessionId = vi.fn();

    const lease = await acquireCursorSdkAgent({
      sessionId: "agent-existing",
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      onSessionId,
    });

    expect(lease.agentId).toBe("agent-existing");
    expect(onSessionId).toHaveBeenCalledWith("agent-existing");
    expect(fakeCursorSdkCreateRequests).toHaveLength(0);
    expect(fakeCursorSdkResumeRequests).toEqual([{
      agentId: "agent-existing",
      options: {
        apiKey: "cursor-key",
        local: { cwd: "/tmp/project" },
      },
    }]);

    lease.release();
  });

  it("closes idle agents after the pool TTL", async () => {
    vi.useFakeTimers();
    const lease = await acquireCursorSdkAgent({
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      idleTimeoutMs: 100,
    });

    lease.release();
    expect(fakeCursorSdkAgents.get("agent-1")?.closed).toBe(false);

    vi.advanceTimersByTime(100);

    expect(fakeCursorSdkAgents.get("agent-1")?.closed).toBe(true);
  });
});
