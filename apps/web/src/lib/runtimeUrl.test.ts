import { describe, it, expect, beforeEach, vi } from "vitest";

describe("resolveRuntimeApiBase", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("module exports resolve functions", async () => {
    const mod = await import("./runtimeUrl");
    expect(typeof mod.resolveRuntimeApiBase).toBe("function");
    expect(typeof mod.resolveRuntimeApiBases).toBe("function");
  });
});
