import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("workspaceUiDiagnose", () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState({}, "", "/");
    window.localStorage.removeItem("codesymphony.workspaceDiagnose");
    window.__CS_DEBUG_LOG__ = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem("codesymphony.workspaceDiagnose");
    delete window.__CS_DEBUG_LOG__;
  });

  it("is disabled unless query or localStorage opts in", async () => {
    const { isWorkspaceUiDiagnoseEnabled } = await import("./workspaceUiDiagnose");
    expect(isWorkspaceUiDiagnoseEnabled()).toBe(false);

    window.history.replaceState({}, "", "/?workspaceDiagnose=1");
    vi.resetModules();
    const modQuery = await import("./workspaceUiDiagnose");
    expect(modQuery.isWorkspaceUiDiagnoseEnabled()).toBe(true);
  });

  it("logs empty-state resolution when diagnose is enabled", async () => {
    window.history.replaceState({}, "", "/?workspaceDiagnose=1");
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    const { logWorkspaceEmptyStateResolution } = await import("./workspaceUiDiagnose");
    logWorkspaceEmptyStateResolution("useChatSession", {
      resolved: "existing-thread-empty",
      threadId: "t1",
    });

    expect(window.__CS_DEBUG_LOG__).toHaveLength(1);
    expect(window.__CS_DEBUG_LOG__?.[0]?.source).toBe("workspace.ui.emptyState");
    expect(window.__CS_DEBUG_LOG__?.[0]?.message).toBe("resolved");
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("skips logs when diagnose is disabled", async () => {
    const { logWorkspaceEmptyStateResolution } = await import("./workspaceUiDiagnose");
    logWorkspaceEmptyStateResolution("useChatSession", { resolved: "loading-thread" });
    expect(window.__CS_DEBUG_LOG__).toEqual([]);
  });

  it("emits issue report UI signals without workspaceDiagnose opt-in", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    const { logWorkspaceUiIssueReportSignal } = await import("./workspaceUiDiagnose");
    logWorkspaceUiIssueReportSignal("emptyState.snapshot", { resolved: "new-thread-empty" }, { threadId: "t1" });

    expect(window.__CS_DEBUG_LOG__).toHaveLength(1);
    expect(window.__CS_DEBUG_LOG__?.[0]?.source).toBe("workspace.ui.issueReport");
  });

  it("collects client debug buffer for issue reports", async () => {
    window.__CS_DEBUG_LOG__ = [
      {
        seq: 1,
        ts: 12.5,
        source: "workspace.ui.emptyState",
        message: "resolved",
        data: { resolved: "loading-thread" },
      },
    ];

    const { collectIssueReportClientDebugEntries } = await import("./workspaceUiDiagnose");
    expect(collectIssueReportClientDebugEntries()).toEqual([
      {
        seq: 1,
        ts: 12.5,
        source: "workspace.ui.emptyState",
        message: "resolved",
        data: { resolved: "loading-thread" },
      },
    ]);
  });
});