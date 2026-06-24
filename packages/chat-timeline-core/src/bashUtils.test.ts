import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { extractBashRuns } from "./bashUtils.js";

function makeEvent(
  idx: number,
  type: ChatEvent["type"],
  payload: Record<string, unknown>,
): ChatEvent {
  return {
    id: `evt-${idx}`,
    threadId: "thread-1",
    idx,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("extractBashRuns", () => {
  it("absorbs Cursor shell tool.output events into the bash run by toolUseId", () => {
    const events = [
      makeEvent(1, "tool.started", {
        toolName: "shell",
        toolUseId: "tool-shell-1",
        command: "cd /tmp && pwd",
        shell: "bash",
        isBash: true,
      }),
      makeEvent(2, "tool.output", {
        toolName: "shell",
        toolUseId: "tool-shell-1",
        elapsedTimeSeconds: 0.5,
      }),
      makeEvent(3, "tool.finished", {
        toolName: "shell",
        summary: "Ran cd /tmp && pwd",
        precedingToolUseIds: ["tool-shell-1"],
        command: "cd /tmp && pwd",
        shell: "bash",
        isBash: true,
        output: "/tmp\n",
      }),
    ];

    const runs = extractBashRuns(events);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.eventIds).toEqual(new Set(["evt-1", "evt-2", "evt-3"]));
    expect(runs[0]?.command).toBe("cd /tmp && pwd");
  });
});