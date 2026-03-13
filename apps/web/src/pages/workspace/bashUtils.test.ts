import { describe, it, expect } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { extractBashRuns } from "./bashUtils";

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

describe("extractBashRuns", () => {
  it("returns empty array for empty events", () => {
    expect(extractBashRuns([])).toEqual([]);
  });

  it("returns empty for non-bash events", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "edit", toolUseId: "t1" } }),
    ];
    expect(extractBashRuns(events)).toEqual([]);
  });

  it("reads bash command from toolInput.command", () => {
    const events = [
      makeEvent({
        id: "e-tool-input", type: "tool.started", idx: 1,
        payload: { toolName: "bash", isBash: true, toolUseId: "t-tool-input", toolInput: { command: "git status -sb" } },
      }),
      makeEvent({
        id: "e-tool-input-finished", type: "tool.finished", idx: 2,
        payload: { toolName: "bash", isBash: true, summary: "Ran git status", precedingToolUseIds: ["t-tool-input"] },
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs).toHaveLength(1);
    expect(runs[0].command).toBe("git status -sb");
  });

  it("creates run from bash tool.started + tool.finished", () => {
    const events = [
      makeEvent({
        id: "e1", type: "tool.started", idx: 1,
        payload: { toolName: "bash", isBash: true, toolUseId: "t1", command: "npm install" },
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
      makeEvent({
        id: "e2", type: "tool.finished", idx: 2,
        payload: { toolName: "bash", isBash: true, summary: "Installed dependencies", precedingToolUseIds: ["t1"] },
        createdAt: "2025-01-01T00:00:05.000Z",
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].command).toBe("npm install");
    expect(runs[0].summary).toBe("Installed dependencies");
    expect(runs[0].status).toBe("success");
    expect(runs[0].durationSeconds).toBe(5);
  });

  it("marks run as failed when error is present", () => {
    const events = [
      makeEvent({
        id: "e1", type: "tool.started", idx: 1,
        payload: { toolName: "bash", isBash: true, toolUseId: "t1", command: "npm test" },
      }),
      makeEvent({
        id: "e2", type: "tool.finished", idx: 2,
        payload: { toolName: "bash", isBash: true, error: "Exit code 1", precedingToolUseIds: ["t1"] },
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toBe("Exit code 1");
  });

  it("handles permission request flow for bash", () => {
    const events = [
      makeEvent({
        id: "e1", type: "permission.requested", idx: 1,
        payload: { toolName: "Bash", requestId: "req-1", command: "rm -rf /" },
      }),
      makeEvent({
        id: "e2", type: "permission.resolved", idx: 2,
        payload: { requestId: "req-1", decision: "deny", message: "Rejected by user" },
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].rejectedByUser).toBe(true);
    expect(runs[0].command).toBe("rm -rf /");
  });

  it("handles permission allow flow", () => {
    const events = [
      makeEvent({
        id: "e1", type: "permission.requested", idx: 1,
        payload: { toolName: "Bash", requestId: "req-1", command: "npm install" },
      }),
      makeEvent({
        id: "e2", type: "permission.resolved", idx: 2,
        payload: { requestId: "req-1", decision: "allow" },
      }),
      makeEvent({
        id: "e3", type: "tool.started", idx: 3,
        payload: { toolName: "bash", isBash: true, toolUseId: "t1", command: "npm install" },
      }),
      makeEvent({
        id: "e4", type: "tool.finished", idx: 4,
        payload: { toolName: "bash", isBash: true, summary: "Done", precedingToolUseIds: ["t1"] },
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs.some((r) => r.status === "success")).toBe(true);
  });

  it("tracks elapsed time from tool.output", () => {
    const events = [
      makeEvent({
        id: "e1", type: "tool.started", idx: 1,
        payload: { toolName: "bash", isBash: true, toolUseId: "t1", command: "sleep 5" },
      }),
      makeEvent({
        id: "e2", type: "tool.output", idx: 2,
        payload: { toolName: "bash", isBash: true, toolUseId: "t1", elapsedTimeSeconds: 5.2 },
      }),
      makeEvent({
        id: "e3", type: "tool.finished", idx: 3,
        payload: { toolName: "bash", isBash: true, summary: "Done", precedingToolUseIds: ["t1"] },
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs[0].durationSeconds).toBe(5.2);
  });

  it("tracks output and truncated flag", () => {
    const events = [
      makeEvent({
        id: "e1", type: "tool.started", idx: 1,
        payload: { toolName: "bash", isBash: true, toolUseId: "t1", command: "cat big.log" },
      }),
      makeEvent({
        id: "e2", type: "tool.finished", idx: 2,
        payload: { toolName: "bash", isBash: true, output: "lots of output...", truncated: true, precedingToolUseIds: ["t1"] },
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs[0].output).toBe("lots of output...");
    expect(runs[0].truncated).toBe(true);
  });

  it("handles multiple bash runs sorted by start idx", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "bash", isBash: true, toolUseId: "t1", command: "ls" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "bash", isBash: true, summary: "Listed", precedingToolUseIds: ["t1"] } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "bash", isBash: true, toolUseId: "t2", command: "pwd" } }),
      makeEvent({ id: "e4", type: "tool.finished", idx: 4, payload: { toolName: "bash", isBash: true, summary: "Printed dir", precedingToolUseIds: ["t2"] } }),
    ];
    const runs = extractBashRuns(events);
    expect(runs.length).toBe(2);
    expect(runs[0].command).toBe("ls");
    expect(runs[1].command).toBe("pwd");
  });

  it("creates run from permission-only events (no tool lifecycle)", () => {
    const events = [
      makeEvent({
        id: "e1", type: "permission.requested", idx: 1,
        payload: { toolName: "Bash", requestId: "req-1", command: "echo hello" },
      }),
    ];
    const runs = extractBashRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].summary).toBe("Awaiting approval");
    expect(runs[0].command).toBe("echo hello");
  });
});
