import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { buildTimelineFromSeed } from "../src/timelineAssembler.js";

function makeMessage(id: string, seq: number, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    threadId: "t1",
    seq,
    role,
    content,
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeEvent(idx: number, type: ChatEvent["type"], payload: Record<string, unknown>): ChatEvent {
  return {
    id: `e-${idx}`,
    threadId: "t1",
    idx,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const GROUP_ID = "claude:1000:tu-create-1";
const SUBJECTS = ["echo hello world", "print working directory", "list files in cwd", "show date and time"];

function snapshotItems(statuses: string[]) {
  return SUBJECTS.map((content, index) => ({
    id: String(index + 1),
    content,
    status: statuses[index],
  }));
}

describe("task todo timeline classification", () => {
  it("renders one todo-list and no generic TaskCreate/TaskUpdate tool rows", () => {
    const messages = [
      makeMessage("m1", 0, "user", "Run four tasks."),
      makeMessage("m2", 1, "assistant", "Done."),
    ];

    const events: ChatEvent[] = [];
    let idx = 1;

    // 4 TaskCreate calls (raw tool events) + the coalesced todo.updated snapshots
    for (let i = 1; i <= 4; i += 1) {
      events.push(makeEvent(idx++, "tool.started", { toolName: "TaskCreate", toolUseId: `tu-create-${i}`, messageId: "m2" }));
      events.push(makeEvent(idx++, "tool.finished", { toolName: "TaskCreate", precedingToolUseIds: [`tu-create-${i}`], summary: `Task #${i} created successfully: ${SUBJECTS[i - 1]}`, messageId: "m2" }));
      events.push(makeEvent(idx++, "todo.updated", {
        messageId: "m2",
        agent: "claude",
        groupId: GROUP_ID,
        explanation: null,
        items: snapshotItems(Array.from({ length: 4 }, (_, n) => (n < i ? "pending" : "pending"))).slice(0, i),
      }));
    }

    // 5 TaskUpdate calls (raw tool events) + snapshots
    const updates: Array<[string, string]> = [
      ["1", "in_progress"],
      ["1", "completed"],
      ["2", "completed"],
      ["4", "completed"],
      ["3", "completed"],
    ];
    const statuses = ["pending", "pending", "pending", "pending"];
    let u = 0;
    for (const [taskId, status] of updates) {
      statuses[Number(taskId) - 1] = status;
      events.push(makeEvent(idx++, "tool.started", { toolName: "TaskUpdate", toolUseId: `tu-update-${u}`, messageId: "m2" }));
      events.push(makeEvent(idx++, "tool.finished", { toolName: "TaskUpdate", precedingToolUseIds: [`tu-update-${u}`], summary: "Task updated", messageId: "m2" }));
      events.push(makeEvent(idx++, "todo.updated", {
        messageId: "m2",
        agent: "claude",
        groupId: GROUP_ID,
        explanation: null,
        items: snapshotItems([...statuses]),
      }));
      u += 1;
    }

    events.push(makeEvent(idx++, "message.delta", { role: "assistant", messageId: "m2", delta: "Done." }));
    events.push(makeEvent(idx++, "chat.completed", { messageId: "m2" }));

    const result = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const todoLists = result.items.filter((item) => item.kind === "todo-list");
    expect(todoLists).toHaveLength(1);
    const todoList = todoLists[0] as Extract<typeof todoLists[number], { kind: "todo-list" }>;
    expect(todoList.items).toHaveLength(4);
    expect(todoList.items.every((item) => item.status === "completed")).toBe(true);

    const genericTaskTools = result.items.filter(
      (item) =>
        item.kind === "tool"
        && typeof item.toolName === "string"
        && /^task(create|update|list|get)$/i.test(item.toolName.trim()),
    );
    expect(genericTaskTools).toHaveLength(0);
  });
});
