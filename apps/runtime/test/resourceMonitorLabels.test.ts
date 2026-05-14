import { describe, expect, it } from "vitest";
import { formatResourceMonitorAgentLabel } from "../src/services/chat/resourceMonitorLabels.js";

describe("resourceMonitorLabels", () => {
  it("formats agent labels with the active thread title when available", () => {
    expect(formatResourceMonitorAgentLabel("codex", "Fix resource usage monitor")).toBe(
      "Agent: Codex | Fix resource usage monitor",
    );
    expect(formatResourceMonitorAgentLabel("claude", "  Investigate   idle  snapshot ")).toBe(
      "Agent: Claude | Investigate idle snapshot",
    );
  });

  it("falls back to the agent name when the thread title is blank", () => {
    expect(formatResourceMonitorAgentLabel("cursor", "")).toBe("Agent: Cursor");
    expect(formatResourceMonitorAgentLabel("opencode", "   ")).toBe("Agent: OpenCode");
  });
});
