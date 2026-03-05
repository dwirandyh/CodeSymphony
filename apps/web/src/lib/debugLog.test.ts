import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("debugLog", () => {
  const originalSendBeacon = navigator.sendBeacon;
  const originalPerformance = globalThis.performance;

  beforeEach(() => {
    vi.stubGlobal("navigator", {
      sendBeacon: vi.fn().mockReturnValue(true),
    });
    if (!window.__CS_DEBUG_LOG__) {
      window.__CS_DEBUG_LOG__ = [];
    }
    window.__CS_DEBUG_LOG__.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pushes entry to window.__CS_DEBUG_LOG__", async () => {
    const { debugLog } = await import("./debugLog");
    debugLog("test-source", "test-message", { key: "val" });
    const entries = window.__CS_DEBUG_LOG__;
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(last.source).toBe("test-source");
    expect(last.message).toBe("test-message");
    expect(last.data).toEqual({ key: "val" });
  });

  it("sends beacon to debug endpoint", async () => {
    const { debugLog } = await import("./debugLog");
    debugLog("beacon-test", "hello");
    expect(navigator.sendBeacon).toHaveBeenCalled();
  });

  it("increments seq for each call", async () => {
    const { debugLog } = await import("./debugLog");
    debugLog("src", "msg1");
    debugLog("src", "msg2");
    const entries = window.__CS_DEBUG_LOG__;
    const last2 = entries.slice(-2);
    expect(last2[1].seq).toBeGreaterThan(last2[0].seq);
  });

  it("handles no data parameter", async () => {
    const { debugLog } = await import("./debugLog");
    debugLog("src", "msg");
    const last = window.__CS_DEBUG_LOG__[window.__CS_DEBUG_LOG__.length - 1];
    expect(last.data).toBeUndefined();
  });
});
