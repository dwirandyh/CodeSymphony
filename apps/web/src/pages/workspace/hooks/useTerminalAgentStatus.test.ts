import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTerminalAgentStatusStoreForTest,
  applyTerminalAgentStatusEvent,
  getTerminalAgentStatus,
  hydrateTerminalAgentStatuses,
  setTerminalAgentStatuses,
  subscribeTerminalAgentStatus,
} from "./useTerminalAgentStatus";

describe("terminal agent status store", () => {
  beforeEach(() => {
    __resetTerminalAgentStatusStoreForTest();
  });

  it("returns undefined for an unknown session", () => {
    expect(getTerminalAgentStatus("nope")).toBeUndefined();
  });

  it("applies a workspace sync event keyed by terminalSessionId", () => {
    applyTerminalAgentStatusEvent({
      type: "terminal.agent.status",
      terminalSessionId: "wt1:terminal:abc",
      terminalAgentStatus: "running",
    } as never);
    expect(getTerminalAgentStatus("wt1:terminal:abc")).toBe("running");
  });

  it("ignores events without a terminal session id", () => {
    applyTerminalAgentStatusEvent({
      type: "terminal.agent.status",
      terminalSessionId: null,
      terminalAgentStatus: "running",
    } as never);
    expect(getTerminalAgentStatus("wt1:terminal:abc")).toBeUndefined();
  });

  it("notifies subscribers on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalAgentStatus(listener);
    applyTerminalAgentStatusEvent({
      type: "terminal.agent.status",
      terminalSessionId: "s1",
      terminalAgentStatus: "waiting_approval",
    } as never);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    applyTerminalAgentStatusEvent({
      type: "terminal.agent.status",
      terminalSessionId: "s1",
      terminalAgentStatus: "idle",
    } as never);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when status is unchanged", () => {
    const listener = vi.fn();
    subscribeTerminalAgentStatus(listener);
    setTerminalAgentStatuses([{ sessionId: "s1", status: "running" }]);
    listener.mockClear();
    applyTerminalAgentStatusEvent({
      type: "terminal.agent.status",
      terminalSessionId: "s1",
      terminalAgentStatus: "running",
    } as never);
    expect(listener).not.toHaveBeenCalled();
  });

  it("hydrates from the snapshot endpoint", async () => {
    const getTerminalAgentStatuses = vi
      .fn()
      .mockResolvedValue([{ sessionId: "s1", status: "review_plan" }]);
    await hydrateTerminalAgentStatuses({ getTerminalAgentStatuses } as never);
    expect(getTerminalAgentStatus("s1")).toBe("review_plan");
  });
});
