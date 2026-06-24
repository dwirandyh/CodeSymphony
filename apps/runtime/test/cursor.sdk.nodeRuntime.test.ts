import { afterEach, describe, expect, it, vi } from "vitest";

describe("Cursor SDK node runtime detection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not delegate when not running under Bun", async () => {
    const bun = (globalThis as { Bun?: unknown }).Bun;
    delete (globalThis as { Bun?: unknown }).Bun;

    const { shouldRunCursorSdkInNodeProcess } = await import("../src/cursor/sdk/nodeRuntime.js");
    expect(shouldRunCursorSdkInNodeProcess()).toBe(false);

    if (bun !== undefined) {
      (globalThis as { Bun?: unknown }).Bun = bun;
    }
  });

  it("delegates Cursor SDK turns to Node when running under Bun", async () => {
    (globalThis as { Bun?: unknown }).Bun = {};
    vi.stubEnv("CODESYMPHONY_CURSOR_SDK_FORCE_IN_PROCESS", "");

    const { shouldRunCursorSdkInNodeProcess } = await import("../src/cursor/sdk/nodeRuntime.js");
    expect(shouldRunCursorSdkInNodeProcess()).toBe(true);
  });

  it("allows forcing in-process SDK execution under Bun for debugging", async () => {
    (globalThis as { Bun?: unknown }).Bun = {};
    vi.stubEnv("CODESYMPHONY_CURSOR_SDK_FORCE_IN_PROCESS", "true");

    const { shouldRunCursorSdkInNodeProcess } = await import("../src/cursor/sdk/nodeRuntime.js");
    expect(shouldRunCursorSdkInNodeProcess()).toBe(false);
  });
});