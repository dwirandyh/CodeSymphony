import { describe, it, expect } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { extractSubagentGroups } from "./subagentUtils";

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
});
