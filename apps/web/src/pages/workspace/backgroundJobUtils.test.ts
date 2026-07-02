import { describe, it, expect } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { extractActiveBackgroundJobs } from "./backgroundJobUtils";

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

describe("extractActiveBackgroundJobs", () => {
  it("returns empty array for empty events", () => {
    expect(extractActiveBackgroundJobs([])).toEqual([]);
  });

  it("lists a running Monitor tool with description and elapsed time", () => {
    const events = [
      makeEvent({
        id: "e1",
        type: "tool.started",
        idx: 1,
        payload: {
          toolName: "Monitor",
          toolUseId: "mon-1",
          description: "errors in deploy.log",
          toolInput: { command: "tail -f deploy.log | grep ERROR", description: "errors in deploy.log" },
        },
      }),
      makeEvent({
        id: "e2",
        type: "tool.output",
        idx: 2,
        payload: {
          toolName: "Monitor",
          toolUseId: "mon-1",
          elapsedTimeSeconds: 134,
        },
      }),
    ];

    const jobs = extractActiveBackgroundJobs(events);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      toolUseId: "mon-1",
      kind: "monitor",
      label: "errors in deploy.log",
      status: "running",
      elapsedSeconds: 134,
    });
  });

  it("omits Monitor jobs that received tool.finished", () => {
    const events = [
      makeEvent({
        id: "e1",
        type: "tool.started",
        idx: 1,
        payload: { toolName: "Monitor", toolUseId: "mon-1", description: "watch CI" },
      }),
      makeEvent({
        id: "e2",
        type: "tool.finished",
        idx: 2,
        payload: { toolName: "Monitor", precedingToolUseIds: ["mon-1"] },
      }),
    ];

    expect(extractActiveBackgroundJobs(events)).toEqual([]);
  });
});