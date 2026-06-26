import { describe, expect, it } from "vitest";
import type { AgentTodoItem } from "@codesymphony/shared-types";
import {
  maybeEmitTaskTodoUpdate,
  type HookCallbacks,
  type SessionState,
} from "../src/claude/sessionHooks";

type CapturedSnapshot = {
  groupId: string;
  items: AgentTodoItem[];
};

function createState(): SessionState {
  return {
    finalOutput: "",
    planFileDetected: false,
    todoGroupId: null,
    emittedTodoToolUseIds: new Set<string>(),
    taskItems: new Map(),
    queryStartTimestamp: 1000,
    promptSuggestions: [],
    recentDiagnostics: [],
    resultSummary: null,
  };
}

function createCallbacks(snapshots: CapturedSnapshot[]): HookCallbacks {
  const noop = async () => {};
  return {
    onToolStarted: noop,
    onToolFinished: noop,
    onQuestionRequest: async () => ({ answers: {} }),
    onPermissionRequest: async () => ({ decision: "allow" }),
    onPlanFileDetected: noop,
    onSubagentStarted: noop,
    onSubagentStopped: noop,
    onTodoUpdate: async (payload) => {
      snapshots.push({
        groupId: payload.groupId,
        items: payload.items.map((item) => ({ ...item })),
      });
    },
  } as unknown as HookCallbacks;
}

describe("claude task todo accumulator", () => {
  it("accumulates incremental TaskCreate/TaskUpdate calls into full snapshots", async () => {
    const snapshots: CapturedSnapshot[] = [];
    const callbacks = createCallbacks(snapshots);
    const state = createState();

    const creates = [
      { id: 1, subject: "echo hello world" },
      { id: 2, subject: "print working directory" },
      { id: 3, subject: "list files in cwd" },
      { id: 4, subject: "show date and time" },
    ];

    for (const create of creates) {
      await maybeEmitTaskTodoUpdate(
        callbacks,
        state,
        "TaskCreate",
        { subject: create.subject, description: "" },
        `Task #${create.id} created successfully: ${create.subject}`,
        `tu-create-${create.id}`,
      );
    }

    const afterCreates = snapshots[snapshots.length - 1];
    expect(afterCreates).toBeDefined();
    expect(afterCreates!.items).toHaveLength(4);
    expect(afterCreates!.items.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
    expect(afterCreates!.items.map((item) => item.content)).toEqual(creates.map((c) => c.subject));
    expect(afterCreates!.items.every((item) => item.status === "pending")).toBe(true);

    await maybeEmitTaskTodoUpdate(
      callbacks,
      state,
      "TaskUpdate",
      { taskId: "1", status: "in_progress" },
      undefined,
      "tu-update-1-progress",
    );

    const afterInProgress = snapshots[snapshots.length - 1]!;
    expect(afterInProgress.items.find((item) => item.id === "1")?.status).toBe("in_progress");
    expect(
      afterInProgress.items.filter((item) => item.id !== "1").every((item) => item.status === "pending"),
    ).toBe(true);

    const completions: Array<[string, string]> = [
      ["1", "tu-update-1-done"],
      ["2", "tu-update-2-done"],
      ["4", "tu-update-4-done"],
      ["3", "tu-update-3-done"],
    ];
    for (const [taskId, toolUseId] of completions) {
      await maybeEmitTaskTodoUpdate(
        callbacks,
        state,
        "TaskUpdate",
        { taskId, status: "completed" },
        undefined,
        toolUseId,
      );
    }

    const final = snapshots[snapshots.length - 1]!;
    expect(final.items).toHaveLength(4);
    expect(final.items.every((item) => item.status === "completed")).toBe(true);
    expect(final.items.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);

    const groupIds = new Set(snapshots.map((snapshot) => snapshot.groupId));
    expect(groupIds.size).toBe(1);
  });

  it("falls back to creation-order ids when the result text lacks Task #N", async () => {
    const snapshots: CapturedSnapshot[] = [];
    const callbacks = createCallbacks(snapshots);
    const state = createState();

    await maybeEmitTaskTodoUpdate(callbacks, state, "TaskCreate", { subject: "first" }, undefined, "a");
    await maybeEmitTaskTodoUpdate(callbacks, state, "TaskCreate", { subject: "second" }, undefined, "b");

    const last = snapshots[snapshots.length - 1]!;
    expect(last.items.map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("drops items on TaskUpdate status deleted", async () => {
    const snapshots: CapturedSnapshot[] = [];
    const callbacks = createCallbacks(snapshots);
    const state = createState();

    await maybeEmitTaskTodoUpdate(callbacks, state, "TaskCreate", { subject: "keep" }, "Task #1 created successfully: keep", "a");
    await maybeEmitTaskTodoUpdate(callbacks, state, "TaskCreate", { subject: "remove" }, "Task #2 created successfully: remove", "b");
    await maybeEmitTaskTodoUpdate(callbacks, state, "TaskUpdate", { taskId: "2", status: "deleted" }, undefined, "c");

    const last = snapshots[snapshots.length - 1]!;
    expect(last.items.map((item) => item.id)).toEqual(["1"]);
  });

  it("ignores read-only TaskList/TaskGet calls", async () => {
    const snapshots: CapturedSnapshot[] = [];
    const callbacks = createCallbacks(snapshots);
    const state = createState();

    await maybeEmitTaskTodoUpdate(callbacks, state, "TaskList", {}, "1. task", "a");
    await maybeEmitTaskTodoUpdate(callbacks, state, "TaskGet", { taskId: "1" }, "task detail", "b");

    expect(snapshots).toHaveLength(0);
  });
});
