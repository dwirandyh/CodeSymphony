import { describe, it, expect } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { extractSubagentGroups } from "./subagentUtils";
import { extractExploreActivityGroups } from "./exploreUtils";

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
  it("returns empty for empty events", () => {
    expect(extractSubagentGroups([])).toEqual([]);
  });

  it("returns empty for events without subagents", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "bash" } }),
    ];
    expect(extractSubagentGroups(events)).toEqual([]);
  });

  it("creates group from subagent.started + subagent.finished", () => {
    const events = [
      makeEvent({
        id: "e1", type: "subagent.started", idx: 1,
        payload: { agentId: "a1", agentType: "generalPurpose", toolUseId: "sa-1", description: "Explore codebase" },
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
      makeEvent({
        id: "e2", type: "subagent.finished", idx: 5,
        payload: { toolUseId: "sa-1", lastMessage: "Found 10 files" },
        createdAt: "2025-01-01T00:00:10.000Z",
      }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].agentType).toBe("generalPurpose");
    expect(groups[0].description).toBe("Explore codebase");
    expect(groups[0].lastMessage).toBe("Found 10 files");
    expect(groups[0].status).toBe("success");
    expect(groups[0].durationSeconds).toBe(10);
  });

  it("collects child tool events as steps", () => {
    const events = [
      makeEvent({
        id: "e1", type: "subagent.started", idx: 1,
        payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "Search" },
      }),
      makeEvent({
        id: "e2", type: "tool.started", idx: 2,
        payload: { toolName: "Glob", toolUseId: "child-1", parentToolUseId: "sa-1" },
      }),
      makeEvent({
        id: "e3", type: "tool.finished", idx: 3,
        payload: { toolName: "Glob", summary: "Found 5 files", toolUseId: "child-1-done", precedingToolUseIds: ["child-1"] },
      }),
      makeEvent({
        id: "e4", type: "subagent.finished", idx: 4,
        payload: { toolUseId: "sa-1", lastMessage: "Done" },
      }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].steps.length).toBe(1);
    expect(groups[0].steps[0].label).toContain("Found 5 files");
    expect(groups[0].steps[0].status).toBe("success");
  });

  it("marks in-progress subagent as running", () => {
    const events = [
      makeEvent({
        id: "e1", type: "subagent.started", idx: 1,
        payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "Working" },
      }),
      makeEvent({
        id: "e2", type: "tool.started", idx: 2,
        payload: { toolName: "Read", toolUseId: "child-1", parentToolUseId: "sa-1" },
      }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].status).toBe("running");
    expect(groups[0].steps.length).toBe(1);
    expect(groups[0].steps[0].status).toBe("running");
  });

  it("links Task tool.started to subagent", () => {
    const events = [
      makeEvent({
        id: "e1", type: "tool.started", idx: 1,
        payload: { toolName: "Task", toolUseId: "call_123" },
      }),
      makeEvent({
        id: "e2", type: "subagent.started", idx: 2,
        payload: { agentId: "a1", agentType: "generalPurpose", toolUseId: "sa-1", description: "Task" },
      }),
      makeEvent({
        id: "e3", type: "subagent.finished", idx: 3,
        payload: { toolUseId: "sa-1", lastMessage: "Done" },
      }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].eventIds.has("e1")).toBe(true);
  });

  it("handles multiple subagents in order", () => {
    const events = [
      makeEvent({
        id: "e1", type: "subagent.started", idx: 1,
        payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "First" },
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
      makeEvent({
        id: "e2", type: "subagent.finished", idx: 2,
        payload: { toolUseId: "sa-1", lastMessage: "Done 1" },
        createdAt: "2025-01-01T00:00:05.000Z",
      }),
      makeEvent({
        id: "e3", type: "subagent.started", idx: 3,
        payload: { agentId: "a2", agentType: "shell", toolUseId: "sa-2", description: "Second" },
        createdAt: "2025-01-01T00:00:06.000Z",
      }),
      makeEvent({
        id: "e4", type: "subagent.finished", idx: 4,
        payload: { toolUseId: "sa-2", lastMessage: "Done 2" },
        createdAt: "2025-01-01T00:00:10.000Z",
      }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups.length).toBe(2);
    expect(groups[0].description).toBe("First");
    expect(groups[1].description).toBe("Second");
  });

  it("skips subagent.started without toolUseId", () => {
    const events = [
      makeEvent({
        id: "e1", type: "subagent.started", idx: 1,
        payload: { agentId: "a1", agentType: "explore", toolUseId: "", description: "Bad" },
      }),
    ];
    expect(extractSubagentGroups(events)).toEqual([]);
  });

  it("uses description from finish event if start had none", () => {
    const events = [
      makeEvent({
        id: "e1", type: "subagent.started", idx: 1,
        payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "" },
      }),
      makeEvent({
        id: "e2", type: "subagent.finished", idx: 2,
        payload: { toolUseId: "sa-1", description: "From transcript", lastMessage: "Done" },
      }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups[0].description).toBe("From transcript");
  });

  it("claims Task tool.finished event with subagentResponse", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Task", toolUseId: "sa-1" } }),
      makeEvent({ id: "e2", type: "subagent.started", idx: 2, payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "Task" } }),
      makeEvent({ id: "e3", type: "subagent.finished", idx: 3, payload: { toolUseId: "sa-1", lastMessage: "initial" } }),
      makeEvent({ id: "e4", type: "tool.finished", idx: 4, payload: { toolUseId: "sa-1", subagentResponse: "final response" } }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].lastMessage).toBe("final response");
  });

  it("claims child events via index range fallback", () => {
    const events = [
      makeEvent({ id: "e1", type: "subagent.started", idx: 1, payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "Search" } }),
      makeEvent({ id: "e2", type: "tool.started", idx: 2, payload: { toolName: "Read", toolUseId: "child-1" } }),
      makeEvent({ id: "e3", type: "tool.finished", idx: 3, payload: { toolName: "Read", summary: "Read file.ts", precedingToolUseIds: ["child-1"] } }),
      makeEvent({ id: "e4", type: "subagent.finished", idx: 4, payload: { toolUseId: "sa-1", lastMessage: "Done" } }),
    ];
    const groups = extractSubagentGroups(events);
    expect(groups[0].steps.length).toBe(1);
    expect(groups[0].eventIds.has("e2")).toBe(true);
    expect(groups[0].eventIds.has("e3")).toBe(true);
  });

  it("keeps overlap with explicit parentToolUseId separated", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Task", toolUseId: "call_1" } }),
      makeEvent({ id: "e2", type: "subagent.started", idx: 2, payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "First" } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "Task", toolUseId: "call_2" } }),
      makeEvent({ id: "e4", type: "subagent.started", idx: 4, payload: { agentId: "a2", agentType: "explore", toolUseId: "sa-2", description: "Second" } }),
      makeEvent({ id: "e5", type: "tool.started", idx: 5, payload: { toolName: "Read", toolUseId: "child-a", parentToolUseId: "sa-1" } }),
      makeEvent({ id: "e6", type: "tool.started", idx: 6, payload: { toolName: "Read", toolUseId: "child-b", parentToolUseId: "sa-2" } }),
      makeEvent({ id: "e7", type: "tool.finished", idx: 7, payload: { toolName: "Read", toolUseId: "child-a-done", precedingToolUseIds: ["child-a"], summary: "Read a.ts" } }),
      makeEvent({ id: "e8", type: "tool.finished", idx: 8, payload: { toolName: "Read", toolUseId: "child-b-done", precedingToolUseIds: ["child-b"], summary: "Read b.ts" } }),
      makeEvent({ id: "e9", type: "subagent.finished", idx: 9, payload: { toolUseId: "sa-1", lastMessage: "done 1" } }),
      makeEvent({ id: "e10", type: "subagent.finished", idx: 10, payload: { toolUseId: "sa-2", lastMessage: "done 2" } }),
    ];

    const groups = extractSubagentGroups(events);
    const byToolUseId = new Map(groups.map((group) => [group.toolUseId, group]));

    const first = byToolUseId.get("sa-1");
    const second = byToolUseId.get("sa-2");
    expect(first?.steps.some((step) => step.label.includes("a.ts"))).toBe(true);
    expect(first?.steps.some((step) => step.label.includes("b.ts"))).toBe(false);
    expect(second?.steps.some((step) => step.label.includes("b.ts"))).toBe(true);
    expect(second?.steps.some((step) => step.label.includes("a.ts"))).toBe(false);
  });

  it("uses precedingToolUseIds lineage during overlap when finish events have no parent", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Task", toolUseId: "call_1" } }),
      makeEvent({ id: "e2", type: "subagent.started", idx: 2, payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "First" } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "Task", toolUseId: "call_2" } }),
      makeEvent({ id: "e4", type: "subagent.started", idx: 4, payload: { agentId: "a2", agentType: "explore", toolUseId: "sa-2", description: "Second" } }),
      makeEvent({ id: "e5", type: "tool.started", idx: 5, payload: { toolName: "Read", toolUseId: "child-a", parentToolUseId: "sa-1" } }),
      makeEvent({ id: "e6", type: "tool.started", idx: 6, payload: { toolName: "Read", toolUseId: "child-b", parentToolUseId: "sa-2" } }),
      makeEvent({ id: "e7", type: "tool.finished", idx: 7, payload: { toolName: "Read", toolUseId: "child-a-done", precedingToolUseIds: ["child-a"], summary: "Read app/a.ts" } }),
      makeEvent({ id: "e8", type: "tool.finished", idx: 8, payload: { toolName: "Read", toolUseId: "child-b-done", precedingToolUseIds: ["child-b"], summary: "Read app/b.ts" } }),
      makeEvent({ id: "e9", type: "subagent.finished", idx: 9, payload: { toolUseId: "sa-1", lastMessage: "done 1" } }),
      makeEvent({ id: "e10", type: "subagent.finished", idx: 10, payload: { toolUseId: "sa-2", lastMessage: "done 2" } }),
    ];

    const groups = extractSubagentGroups(events);
    const byToolUseId = new Map(groups.map((group) => [group.toolUseId, group]));

    const first = byToolUseId.get("sa-1");
    const second = byToolUseId.get("sa-2");
    expect(first?.steps.some((step) => step.label.includes("a.ts"))).toBe(true);
    expect(second?.steps.some((step) => step.label.includes("b.ts"))).toBe(true);
    expect(first?.eventIds.has("e8")).toBe(false);
    expect(second?.eventIds.has("e7")).toBe(false);
  });

  it("does not claim ambiguous overlap events without lineage", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Task", toolUseId: "call_1" } }),
      makeEvent({ id: "e2", type: "subagent.started", idx: 2, payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "First" } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "Task", toolUseId: "call_2" } }),
      makeEvent({ id: "e4", type: "subagent.started", idx: 4, payload: { agentId: "a2", agentType: "explore", toolUseId: "sa-2", description: "Second" } }),
      makeEvent({ id: "e5", type: "tool.started", idx: 5, payload: { toolName: "Read", toolUseId: "ambiguous-1" } }),
      makeEvent({ id: "e6", type: "tool.finished", idx: 6, payload: { toolName: "Read", toolUseId: "ambiguous-1-done", summary: "Read maybe" } }),
      makeEvent({ id: "e7", type: "subagent.finished", idx: 7, payload: { toolUseId: "sa-1", lastMessage: "done 1" } }),
      makeEvent({ id: "e8", type: "subagent.finished", idx: 8, payload: { toolUseId: "sa-2", lastMessage: "done 2" } }),
    ];

    const groups = extractSubagentGroups(events);
    const claimedEventIds = new Set(groups.flatMap((group) => [...group.eventIds]));
    expect(claimedEventIds.has("e5")).toBe(false);
    expect(claimedEventIds.has("e6")).toBe(false);
    expect(groups.every((group) => group.steps.length === 0)).toBe(true);
  });

  it("pairs multiple pending Task starts in FIFO order", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Task", toolUseId: "call_1" } }),
      makeEvent({ id: "e2", type: "tool.started", idx: 2, payload: { toolName: "Task", toolUseId: "call_2" } }),
      makeEvent({ id: "e3", type: "subagent.started", idx: 3, payload: { agentId: "a1", agentType: "generalPurpose", toolUseId: "sa-1", description: "First" } }),
      makeEvent({ id: "e4", type: "subagent.started", idx: 4, payload: { agentId: "a2", agentType: "generalPurpose", toolUseId: "sa-2", description: "Second" } }),
      makeEvent({ id: "e5", type: "tool.finished", idx: 5, payload: { toolName: "Task", toolUseId: "call_1", subagentResponse: "first response" } }),
      makeEvent({ id: "e6", type: "tool.finished", idx: 6, payload: { toolName: "Task", toolUseId: "call_2", subagentResponse: "second response" } }),
      makeEvent({ id: "e7", type: "subagent.finished", idx: 7, payload: { toolUseId: "sa-1", lastMessage: "done 1" } }),
      makeEvent({ id: "e8", type: "subagent.finished", idx: 8, payload: { toolUseId: "sa-2", lastMessage: "done 2" } }),
    ];

    const groups = extractSubagentGroups(events);
    const byToolUseId = new Map(groups.map((group) => [group.toolUseId, group]));

    const first = byToolUseId.get("sa-1");
    const second = byToolUseId.get("sa-2");
    expect(first?.eventIds.has("e1")).toBe(true);
    expect(first?.eventIds.has("e5")).toBe(true);
    expect(first?.eventIds.has("e2")).toBe(false);
    expect(first?.eventIds.has("e6")).toBe(false);

    expect(second?.eventIds.has("e2")).toBe(true);
    expect(second?.eventIds.has("e6")).toBe(true);
    expect(second?.eventIds.has("e1")).toBe(false);
    expect(second?.eventIds.has("e5")).toBe(false);
  });

  it("treats Agent launcher events like Task for subagent ownership", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Agent", toolUseId: "call_agent_1" } }),
      makeEvent({ id: "e2", type: "subagent.started", idx: 2, payload: { agentId: "a1", agentType: "Explore", toolUseId: "sa-1", description: "" } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "Read", toolUseId: "child-1" } }),
      makeEvent({ id: "e4", type: "tool.finished", idx: 4, payload: { toolName: "Read", toolUseId: "child-1-done", precedingToolUseIds: ["child-1"], summary: "Read app/README.md" } }),
      makeEvent({ id: "e5", type: "tool.finished", idx: 5, payload: { toolName: "Agent", toolUseId: "call_agent_1", subagentResponse: "agent response" } }),
      makeEvent({ id: "e6", type: "subagent.finished", idx: 6, payload: { toolUseId: "sa-1", description: "Recovered prompt", lastMessage: "done" } }),
    ];

    const groups = extractSubagentGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].eventIds.has("e1")).toBe(true);
    expect(groups[0].eventIds.has("e5")).toBe(true);
  });

  it("claims permission events via explicit canonical subagent owner", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Task", toolUseId: "call_1" } }),
      makeEvent({ id: "e2", type: "subagent.started", idx: 2, payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "First" } }),
      makeEvent({
        id: "e3",
        type: "permission.requested",
        idx: 3,
        payload: {
          requestId: "req-1",
          toolName: "Bash",
          command: "ls",
          subagentOwnerToolUseId: "sa-1",
          launcherToolUseId: "call_1",
        },
      }),
      makeEvent({
        id: "e4",
        type: "permission.resolved",
        idx: 4,
        payload: {
          requestId: "req-1",
          decision: "deny",
          message: "Rejected",
          subagentOwnerToolUseId: "sa-1",
          launcherToolUseId: "call_1",
        },
      }),
      makeEvent({ id: "e5", type: "subagent.finished", idx: 5, payload: { toolUseId: "sa-1", lastMessage: "done" } }),
    ];

    const groups = extractSubagentGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].eventIds.has("e3")).toBe(true);
    expect(groups[0].eventIds.has("e4")).toBe(true);
  });

  it("does not claim ambiguous permission events during overlap without ownership metadata", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Task", toolUseId: "call_1" } }),
      makeEvent({ id: "e2", type: "subagent.started", idx: 2, payload: { agentId: "a1", agentType: "explore", toolUseId: "sa-1", description: "First" } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "Task", toolUseId: "call_2" } }),
      makeEvent({ id: "e4", type: "subagent.started", idx: 4, payload: { agentId: "a2", agentType: "explore", toolUseId: "sa-2", description: "Second" } }),
      makeEvent({ id: "e5", type: "permission.requested", idx: 5, payload: { requestId: "req-amb", toolName: "Bash", command: "pwd" } }),
      makeEvent({ id: "e6", type: "permission.resolved", idx: 6, payload: { requestId: "req-amb", decision: "deny", message: "Rejected" } }),
      makeEvent({ id: "e7", type: "subagent.finished", idx: 7, payload: { toolUseId: "sa-1", lastMessage: "done 1" } }),
      makeEvent({ id: "e8", type: "subagent.finished", idx: 8, payload: { toolUseId: "sa-2", lastMessage: "done 2" } }),
    ];

    const groups = extractSubagentGroups(events);
    const claimedEventIds = new Set(groups.flatMap((group) => [...group.eventIds]));
    expect(claimedEventIds.has("e5")).toBe(false);
    expect(claimedEventIds.has("e6")).toBe(false);
  });
});

describe("extractExploreActivityGroups", () => {
  it("builds standalone explore groups from main-agent explore events", () => {
    const events = [
      makeEvent({
        id: "e1",
        type: "tool.started",
        idx: 1,
        payload: { toolName: "Read", toolUseId: "r1" },
      }),
      makeEvent({
        id: "e2",
        type: "tool.finished",
        idx: 2,
        payload: { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["r1"] },
      }),
      makeEvent({
        id: "e3",
        type: "tool.started",
        idx: 3,
        payload: { toolName: "Glob", toolUseId: "g1", searchParams: "src/**/*.ts" },
      }),
      makeEvent({
        id: "e4",
        type: "tool.finished",
        idx: 4,
        payload: { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] },
      }),
    ];

    const groups = extractExploreActivityGroups(events);
    expect(groups).toHaveLength(1);

    const group = groups[0];
    expect(group.fileCount).toBe(1);
    expect(group.searchCount).toBe(1);
    expect(group.entries).toHaveLength(2);

    const claimedEventIds = new Set<string>([...group.eventIds]);
    expect(claimedEventIds.has("e1")).toBe(true);
    expect(claimedEventIds.has("e2")).toBe(true);
    expect(claimedEventIds.has("e3")).toBe(true);
    expect(claimedEventIds.has("e4")).toBe(true);
  });
});
