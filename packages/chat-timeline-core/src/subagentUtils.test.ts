import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { extractSubagentGroups } from "./subagentUtils.js";

function makeEvent(overrides: Partial<ChatEvent> & { type: ChatEvent["type"] }): ChatEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    idx: 0,
    payload: {},
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("extractSubagentGroups", () => {
  it("skips failed Agent launchers when pairing the next subagent", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Agent", toolUseId: "call_failed" } }),
      makeEvent({ id: "e2", type: "tool.started", idx: 2, payload: { toolName: "Agent", toolUseId: "call_success" } }),
      makeEvent({
        id: "e3",
        type: "tool.finished",
        idx: 3,
        payload: {
          summary: "Agent failed",
          precedingToolUseIds: ["call_failed"],
          error: "Failed to create worktree",
        },
      }),
      makeEvent({ id: "e4", type: "subagent.started", idx: 4, payload: { agentId: "a1", agentType: "Explore", toolUseId: "sa-1", description: "Explore profile flow" } }),
      makeEvent({ id: "e5", type: "subagent.finished", idx: 5, payload: { toolUseId: "sa-1", description: "Explore profile flow", lastMessage: "" } }),
      makeEvent({
        id: "e6",
        type: "tool.finished",
        idx: 6,
        payload: {
          toolName: "Agent",
          summary: "Completed Agent",
          precedingToolUseIds: ["call_success"],
          subagentResponse: "final response",
        },
      }),
    ];

    const groups = extractSubagentGroups(events);

    expect(groups).toHaveLength(1);
    expect(groups[0].eventIds.has("e1")).toBe(false);
    expect(groups[0].eventIds.has("e2")).toBe(true);
    expect(groups[0].eventIds.has("e6")).toBe(true);
    expect(groups[0].lastMessage).toBe("final response");
  });
});
