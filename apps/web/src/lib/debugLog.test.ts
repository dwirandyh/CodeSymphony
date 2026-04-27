import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("debugLog", () => {
  beforeEach(() => {
    vi.resetModules();
    window.__CS_DEBUG_LOG__ = [];
    window.__CS_DEBUG_LOG_ENABLED__ = false;
    window.history.replaceState({}, "", "/");
    window.localStorage.removeItem("codesymphony.debugLog");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__CS_DEBUG_LOG__;
    delete window.__CS_DEBUG_LOG_ENABLED__;
    window.localStorage.removeItem("codesymphony.debugLog");
  });

  it("keeps verbose pagination logs disabled by default", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    const { debugLog } = await import("./debugLog");
    debugLog("thread.pagination.ui", "scroll.sample", { offset: 80 });

    expect(window.__CS_DEBUG_LOG__).toEqual([]);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("still records non-verbose logs without explicit opt-in", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    const { debugLog } = await import("./debugLog");
    debugLog("thread.navigation", "ready", { threadId: "t1" });

    expect(window.__CS_DEBUG_LOG__).toHaveLength(1);
    expect(window.__CS_DEBUG_LOG__?.[0]?.source).toBe("thread.navigation");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("allows verbose pagination logs when explicit opt-in is enabled", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    window.__CS_DEBUG_LOG_ENABLED__ = true;

    const { debugLog } = await import("./debugLog");
    debugLog("thread.pagination.state", "loadOlder.started", { threadId: "t1" });

    expect(window.__CS_DEBUG_LOG__).toHaveLength(1);
    expect(window.__CS_DEBUG_LOG__?.[0]?.source).toBe("thread.pagination.state");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });
});
