import { describe, expect, it } from "vitest";
import { __testing } from "../src/services/chat/chatNamingService";

describe("chat naming service", () => {
  it("uses default mode for opencode naming helpers", () => {
    expect(__testing.resolveNamingPermissionMode("opencode")).toBe("default");
  });

  it("keeps plan mode for other agents", () => {
    expect(__testing.resolveNamingPermissionMode("claude")).toBe("plan");
    expect(__testing.resolveNamingPermissionMode("codex")).toBe("plan");
  });
});
