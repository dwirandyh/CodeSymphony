import { describe, expect, it } from "vitest";
import { shouldEagerlyEnableCriticalWorkspaceData } from "./startupCriticalData";

describe("startupCriticalData", () => {
  it("eagerly enables critical workspace data for desktop warm-persisted startup", () => {
    expect(shouldEagerlyEnableCriticalWorkspaceData({
      desktopApp: true,
      hasPersistedShellSnapshot: true,
    })).toBe(true);
  });

  it("keeps idle deferral for web or empty startup sessions", () => {
    expect(shouldEagerlyEnableCriticalWorkspaceData({
      desktopApp: false,
      hasPersistedShellSnapshot: true,
    })).toBe(false);
    expect(shouldEagerlyEnableCriticalWorkspaceData({
      desktopApp: true,
      hasPersistedShellSnapshot: false,
    })).toBe(false);
  });
});
