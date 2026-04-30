import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("debugLog", () => {
  beforeEach(() => {
    vi.resetModules();
    window.__CS_DEBUG_LOG__ = [];
    window.__CS_DEBUG_LOG_ENABLED__ = false;
    window.history.replaceState({}, "", "/");
    window.localStorage.removeItem("codesymphony.debugLog");
    window.localStorage.removeItem("codesymphony.debugLog.sources");
    window.localStorage.removeItem("codesymphony.debugLog.threadId");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__CS_DEBUG_LOG__;
    delete window.__CS_DEBUG_LOG_ENABLED__;
    window.localStorage.removeItem("codesymphony.debugLog");
    window.localStorage.removeItem("codesymphony.debugLog.sources");
    window.localStorage.removeItem("codesymphony.debugLog.threadId");
  });

  it("keeps verbose pagination logs disabled by default", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });

    const { debugLog } = await import("./debugLog");
    debugLog("thread.timeline.ui", "scroll.sample", { offset: 80 });

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
    debugLog("thread.timeline.state", "snapshot.hydrated", { threadId: "t1" });

    expect(window.__CS_DEBUG_LOG__).toHaveLength(1);
    expect(window.__CS_DEBUG_LOG__?.[0]?.source).toBe("thread.timeline.state");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("allows matching verbose sources through explicit source filters without global opt-in", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    window.localStorage.setItem("codesymphony.debugLog.sources", "thread.stream");

    const { debugLog } = await import("./debugLog");
    debugLog("thread.stream.lifecycle", "stream.open", { threadId: "t1" });

    expect(window.__CS_DEBUG_LOG__).toHaveLength(1);
    expect(window.__CS_DEBUG_LOG__?.[0]?.source).toBe("thread.stream.lifecycle");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("drops entries whose source does not match the configured source filter", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    window.localStorage.setItem("codesymphony.debugLog.sources", "thread.stream");

    const { debugLog } = await import("./debugLog");
    debugLog("thread.navigation", "ready", { threadId: "t1" });

    expect(window.__CS_DEBUG_LOG__).toEqual([]);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("drops entries whose threadId does not match the configured thread filter", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    window.localStorage.setItem("codesymphony.debugLog.threadId", "thread-1");

    const { debugLog } = await import("./debugLog");
    debugLog("thread.navigation", "ready", { threadId: "thread-2" });
    debugLog("thread.navigation", "ready", { threadId: "thread-1" });

    expect(window.__CS_DEBUG_LOG__).toHaveLength(1);
    expect(window.__CS_DEBUG_LOG__?.[0]?.data).toEqual({ threadId: "thread-1" });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });
});
