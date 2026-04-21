import { describe, it, expect } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import {
  isEditToolName,
  extractEditTargetFromUnknownToolInput,
  extractEditTargetFromSummary,
  buildProposedEditDiffFromToolInput,
  isEditToolLifecycleEvent,
  extractEditedRuns,
} from "./editUtils";

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

describe("isEditToolName", () => {
  it("returns true for edit", () => {
    expect(isEditToolName("edit")).toBe(true);
    expect(isEditToolName("Edit")).toBe(true);
  });

  it("returns true for multiedit", () => {
    expect(isEditToolName("multiedit")).toBe(true);
    expect(isEditToolName("MultiEdit")).toBe(true);
  });

  it("returns true for write", () => {
    expect(isEditToolName("write")).toBe(true);
    expect(isEditToolName("Write")).toBe(true);
  });

  it("returns false for null or non-edit tools", () => {
    expect(isEditToolName(null)).toBe(false);
    expect(isEditToolName("bash")).toBe(false);
    expect(isEditToolName("read")).toBe(false);
  });
});

describe("extractEditTargetFromUnknownToolInput", () => {
  it("extracts from file_path key", () => {
    expect(extractEditTargetFromUnknownToolInput({ file_path: "/src/index.ts" })).toBe("/src/index.ts");
  });

  it("extracts from path key", () => {
    expect(extractEditTargetFromUnknownToolInput({ path: "/src/app.ts" })).toBe("/src/app.ts");
  });

  it("extracts from file key", () => {
    expect(extractEditTargetFromUnknownToolInput({ file: "/src/main.ts" })).toBe("/src/main.ts");
  });

  it("returns null for non-record input", () => {
    expect(extractEditTargetFromUnknownToolInput("string")).toBeNull();
    expect(extractEditTargetFromUnknownToolInput(null)).toBeNull();
    expect(extractEditTargetFromUnknownToolInput([])).toBeNull();
  });

  it("returns null when no matching keys", () => {
    expect(extractEditTargetFromUnknownToolInput({ content: "hello" })).toBeNull();
  });

  it("trims whitespace", () => {
    expect(extractEditTargetFromUnknownToolInput({ file_path: "  /src/index.ts  " })).toBe("/src/index.ts");
  });
});

describe("extractEditTargetFromSummary", () => {
  it("extracts from 'Edited <path>' pattern", () => {
    expect(extractEditTargetFromSummary("Edited /src/index.ts")).toBe("/src/index.ts");
  });

  it("extracts from 'Failed to edit <path>' pattern", () => {
    expect(extractEditTargetFromSummary("Failed to edit /src/app.ts")).toBe("/src/app.ts");
  });

  it("returns null for generic edit summaries", () => {
    expect(extractEditTargetFromSummary("Edited 3 files")).toBeNull();
    expect(extractEditTargetFromSummary("Edited files")).toBeNull();
    expect(extractEditTargetFromSummary("Edited changes")).toBeNull();
  });

  it("returns null for non-matching summaries", () => {
    expect(extractEditTargetFromSummary("Ran bash command")).toBeNull();
  });
});

describe("buildProposedEditDiffFromToolInput", () => {
  it("builds diff from old_string/new_string", () => {
    const input = { old_string: "old line", new_string: "new line" };
    const diff = buildProposedEditDiffFromToolInput(input, "src/file.ts");
    expect(diff).toContain("diff --git a/src/file.ts b/src/file.ts");
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  it("handles content key (new file)", () => {
    const input = { content: "new content" };
    const diff = buildProposedEditDiffFromToolInput(input, "src/file.ts");
    expect(diff).toContain("+new content");
  });

  it("handles edits array", () => {
    const input = {
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    };
    const diff = buildProposedEditDiffFromToolInput(input, "src/file.ts");
    expect(diff).toContain("-a");
    expect(diff).toContain("+b");
    expect(diff).toContain("-c");
    expect(diff).toContain("+d");
  });

  it("returns null for non-record input", () => {
    expect(buildProposedEditDiffFromToolInput("string", "file.ts")).toBeNull();
  });

  it("returns null when no edit content found", () => {
    expect(buildProposedEditDiffFromToolInput({ unrelated: "data" }, "file.ts")).toBeNull();
  });

  it("handles multi-line old/new strings", () => {
    const input = { old_string: "line1\nline2", new_string: "new1\nnew2\nnew3" };
    const diff = buildProposedEditDiffFromToolInput(input, "file.ts")!;
    expect(diff).toContain("-line1");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+new1");
    expect(diff).toContain("+new2");
    expect(diff).toContain("+new3");
    expect(diff).toContain("@@ -1,2 +1,3 @@");
  });
});

describe("isEditToolLifecycleEvent", () => {
  it("returns true for edit tool.started", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "tool.started", payload: { toolName: "edit" } }))).toBe(true);
  });

  it("returns true for edit tool.output", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "tool.output", payload: { toolName: "Write" } }))).toBe(true);
  });

  it("returns true for tool.finished with edit tool name", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "tool.finished", payload: { toolName: "Edit", editTarget: "file.ts" } }))).toBe(true);
  });

  it("returns true for tool.finished with Edited summary", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "tool.finished", payload: { summary: "Edited src/file.ts" } }))).toBe(true);
  });

  it("returns false for tool.finished with editTarget on non-edit tools", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "tool.finished", payload: { toolName: "Read", editTarget: "file.ts" } }))).toBe(false);
  });

  it("returns false for worktree.diff tool.finished", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "tool.finished", payload: { source: "worktree.diff", summary: "Edited src/file.ts" } }))).toBe(false);
  });

  it("returns true for edit permission.requested", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "permission.requested", payload: { toolName: "edit" } }))).toBe(true);
  });

  it("returns false for non-edit events", () => {
    expect(isEditToolLifecycleEvent(makeEvent({ type: "tool.started", payload: { toolName: "bash" } }))).toBe(false);
    expect(isEditToolLifecycleEvent(makeEvent({ type: "message.delta" }))).toBe(false);
  });
});

describe("extractEditedRuns", () => {
  it("returns empty array for empty events", () => {
    expect(extractEditedRuns([])).toEqual([]);
  });

  it("creates run from tool.started + tool.finished", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "edit", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { summary: "Edited src/file.ts", precedingToolUseIds: ["t1"] } }),
    ];
    const runs = extractEditedRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].changedFiles).toContain("src/file.ts");
  });

  it("handles permission request + deny flow", () => {
    const events = [
      makeEvent({ id: "e1", type: "permission.requested", idx: 1, payload: { toolName: "edit", requestId: "req-1", editTarget: "src/file.ts" } }),
      makeEvent({ id: "e2", type: "permission.resolved", idx: 2, payload: { requestId: "req-1", decision: "deny" } }),
    ];
    const runs = extractEditedRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].rejectedByUser).toBe(true);
  });

  it("attaches worktree diff to edit run", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "edit", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { summary: "Edited file.ts", precedingToolUseIds: ["t1"] } }),
      makeEvent({
        id: "e3", type: "tool.finished", idx: 3,
        payload: { source: "worktree.diff", diff: "diff --git a/file.ts b/file.ts\n+new", changedFiles: ["file.ts"] },
      }),
    ];
    const runs = extractEditedRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].diffKind).toBe("actual");
    expect(runs[0].diff).toContain("+new");
  });

  it("splits a multi-file worktree diff across matching edit runs", () => {
    const events = [
      makeEvent({
        id: "e1",
        type: "tool.started",
        idx: 1,
        payload: {
          toolName: "Edit",
          toolUseId: "t1",
          toolInput: { file_path: "/repo/README.md", old_string: "a", new_string: "b" },
        },
      }),
      makeEvent({
        id: "e2",
        type: "tool.finished",
        idx: 2,
        payload: {
          summary: "Edited /repo/README.md",
          precedingToolUseIds: ["t1"],
          editTarget: "/repo/README.md",
        },
      }),
      makeEvent({
        id: "e3",
        type: "tool.started",
        idx: 3,
        payload: {
          toolName: "Edit",
          toolUseId: "t2",
          toolInput: { file_path: "/repo/build.gradle", old_string: "x", new_string: "y" },
        },
      }),
      makeEvent({
        id: "e4",
        type: "tool.finished",
        idx: 4,
        payload: {
          summary: "Edited /repo/build.gradle",
          precedingToolUseIds: ["t2"],
          editTarget: "/repo/build.gradle",
        },
      }),
      makeEvent({
        id: "e5",
        type: "tool.finished",
        idx: 5,
        payload: {
          source: "worktree.diff",
          changedFiles: ["README.md", "build.gradle"],
          diff: [
            "diff --git a/README.md b/README.md",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1 +1 @@",
            "-a",
            "+b",
            "diff --git a/build.gradle b/build.gradle",
            "--- a/build.gradle",
            "+++ b/build.gradle",
            "@@ -1 +1 @@",
            "-x",
            "+y",
          ].join("\n"),
        },
      }),
    ];

    const runs = extractEditedRuns(events);

    expect(runs).toHaveLength(2);
    expect(runs[0].diffKind).toBe("actual");
    expect(runs[1].diffKind).toBe("actual");
    expect(runs[0].diff).toContain("README.md");
    expect(runs[0].diff).not.toContain("build.gradle");
    expect(runs[1].diff).toContain("build.gradle");
    expect(runs[1].diff).not.toContain("README.md");
  });

  it("merges permission and tool edit events into a single actual run", () => {
    const events = [
      makeEvent({
        id: "e1",
        type: "permission.requested",
        idx: 1,
        payload: {
          toolName: "Edit",
          requestId: "perm-1",
          editTarget: "/repo/README.md",
          toolInput: { file_path: "/repo/README.md", old_string: "a", new_string: "b" },
        },
      }),
      makeEvent({
        id: "e2",
        type: "tool.started",
        idx: 2,
        payload: {
          toolName: "Edit",
          toolUseId: "t1",
          toolInput: { file_path: "/repo/README.md", old_string: "a", new_string: "b" },
        },
      }),
      makeEvent({
        id: "e3",
        type: "tool.finished",
        idx: 3,
        payload: {
          summary: "Edited /repo/README.md",
          precedingToolUseIds: ["t1"],
          editTarget: "/repo/README.md",
        },
      }),
      makeEvent({
        id: "e4",
        type: "tool.finished",
        idx: 4,
        payload: {
          source: "worktree.diff",
          changedFiles: ["README.md"],
          diff: [
            "diff --git a/README.md b/README.md",
            "--- a/README.md",
            "+++ b/README.md",
            "@@ -1 +1 @@",
            "-a",
            "+b",
          ].join("\n"),
        },
      }),
    ];

    const runs = extractEditedRuns(events);
    const readmeRuns = runs.filter((run) => run.changedFiles.some((file) => file.includes("README.md")));
    const actualReadmeRuns = readmeRuns.filter((run) => run.diffKind === "actual");

    expect(readmeRuns).toHaveLength(1);
    expect(actualReadmeRuns).toHaveLength(1);
    expect(actualReadmeRuns[0]?.diff).toContain("README.md");
    expect(actualReadmeRuns[0]?.eventIds).toEqual(new Set(["e1", "e2", "e3", "e4"]));
  });

  it("creates proposed diff from tool input on permission request", () => {
    const events = [
      makeEvent({
        id: "e1", type: "permission.requested", idx: 1,
        payload: {
          toolName: "edit",
          requestId: "req-1",
          editTarget: "src/file.ts",
          toolInput: { old_string: "old", new_string: "new" },
        },
      }),
    ];
    const runs = extractEditedRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].diffKind).toBe("proposed");
    expect(runs[0].diff).toContain("-old");
    expect(runs[0].diff).toContain("+new");
  });

  it("creates proposed diff from orphan tool.started payload", () => {
    const events = [
      makeEvent({
        id: "e1",
        type: "tool.started",
        idx: 1,
        payload: {
          toolName: "Write",
          toolUseId: "t1",
          toolInput: {
            file_path: "/tmp/test/main_tab_page_test.dart",
            content: "hello world",
          },
        },
      }),
    ];
    const runs = extractEditedRuns(events);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
    expect(runs[0].changedFiles).toContain("/tmp/test/main_tab_page_test.dart");
    expect(runs[0].diffKind).toBe("proposed");
    expect(runs[0].diff).toContain("diff --git a//tmp/test/main_tab_page_test.dart b//tmp/test/main_tab_page_test.dart");
    expect(runs[0].diff).toContain("+hello world");
  });

  it("handles failed edit from summary", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "edit", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { summary: "Failed to edit file.ts", error: "Something went wrong", precedingToolUseIds: ["t1"] } }),
    ];
    const runs = extractEditedRuns(events);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("failed");
  });

  it("ignores read completions that include editTarget metadata", () => {
    const events = [
      makeEvent({
        id: "e1",
        type: "tool.started",
        idx: 1,
        payload: {
          toolName: "Read",
          toolUseId: "r1",
          toolInput: { file_path: "/repo/README.md" },
        },
      }),
      makeEvent({
        id: "e2",
        type: "tool.finished",
        idx: 2,
        payload: {
          toolName: "Read",
          summary: "Read /repo/README.md",
          precedingToolUseIds: ["r1"],
          editTarget: "/repo/README.md",
        },
      }),
    ];

    expect(extractEditedRuns(events)).toEqual([]);
  });
});
