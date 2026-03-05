import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isRenderDebugEnabled,
  pushRenderDebug,
  getRenderDebugEntries,
  clearRenderDebugEntries,
  subscribeRenderDebug,
  copyRenderDebugLog,
} from "./renderDebug";

function enableRenderDebug() {
  Object.defineProperty(window, "location", {
    value: { search: "?csDebugRender=1" },
    writable: true,
    configurable: true,
  });
}

function disableRenderDebug() {
  Object.defineProperty(window, "location", {
    value: { search: "" },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: { getItem: () => null },
    writable: true,
    configurable: true,
  });
  delete (window as any).__CS_RENDER_DEBUG__;
}

describe("renderDebug", () => {
  beforeEach(() => {
    delete (window as any).__CS_RENDER_DEBUG__;
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  describe("isRenderDebugEnabled", () => {
    it("returns true when URL param is set", () => {
      enableRenderDebug();
      expect(isRenderDebugEnabled()).toBe(true);
    });

    it("returns true when localStorage flag is set", () => {
      Object.defineProperty(window, "location", { value: { search: "" }, writable: true, configurable: true });
      Object.defineProperty(window, "localStorage", {
        value: { getItem: (key: string) => key === "cs.debug.render" ? "1" : null },
        writable: true,
        configurable: true,
      });
      expect(isRenderDebugEnabled()).toBe(true);
    });

    it("returns false when not enabled", () => {
      disableRenderDebug();
      expect(isRenderDebugEnabled()).toBe(false);
    });
  });

  describe("pushRenderDebug", () => {
    it("adds entries when debug is enabled", () => {
      enableRenderDebug();
      pushRenderDebug({ source: "test", event: "render" });
      const entries = getRenderDebugEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].source).toBe("test");
      expect(entries[0].event).toBe("render");
      expect(entries[0].ts).toBeTruthy();
    });

    it("does nothing when debug is disabled", () => {
      disableRenderDebug();
      pushRenderDebug({ source: "test", event: "render" });
      expect(getRenderDebugEntries()).toEqual([]);
    });
  });

  describe("clearRenderDebugEntries", () => {
    it("clears all entries", () => {
      enableRenderDebug();
      pushRenderDebug({ source: "test", event: "render" });
      clearRenderDebugEntries();
      expect(getRenderDebugEntries()).toEqual([]);
    });
  });

  describe("subscribeRenderDebug", () => {
    it("calls listener with current entries immediately", () => {
      enableRenderDebug();
      pushRenderDebug({ source: "test", event: "render" });
      const listener = vi.fn();
      const unsubscribe = subscribeRenderDebug(listener);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].length).toBe(1);
      unsubscribe();
    });

    it("returns unsubscribe function", () => {
      enableRenderDebug();
      const listener = vi.fn();
      const unsubscribe = subscribeRenderDebug(listener);
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });
  });

  describe("copyRenderDebugLog", () => {
    it("returns false when debug is disabled", async () => {
      disableRenderDebug();
      expect(await copyRenderDebugLog()).toBe(false);
    });

    it("returns false when clipboard is unavailable", async () => {
      enableRenderDebug();
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      expect(await copyRenderDebugLog()).toBe(false);
    });

    it("copies entries to clipboard when available", async () => {
      enableRenderDebug();
      pushRenderDebug({ source: "test", event: "copy" });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const result = await copyRenderDebugLog();
      expect(result).toBe(true);
      expect(writeText).toHaveBeenCalledTimes(1);
    });
  });
});
