import { describe, expect, it } from "vitest";
import type { WorktreeStatusSummary } from "./hooks/worktreeThreadStatus";
import {
  pruneSettledWorktreeStatusOverrides,
  reconcileWorktreeStatusOverrides,
} from "./worktreeStatusOverrides";

function makeSummary(
  kind: WorktreeStatusSummary["kind"],
  threadId: string,
): WorktreeStatusSummary {
  return {
    kind,
    threadId,
  };
}

describe("reconcileWorktreeStatusOverrides", () => {
  it("keeps a background override after switching away until authoritative background status catches up", () => {
    expect(reconcileWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("running", "thread-a"),
      },
      selectedWorktreeId: "wt-b",
      selectedWorktreeStatusOverride: null,
      activeThreadIdsByWorktreeId: {},
    })).toEqual({
      "wt-a": makeSummary("running", "thread-a"),
    });
  });

  it("stores the selected worktree override while the selected thread is active", () => {
    expect(reconcileWorktreeStatusOverrides({
      current: {},
      selectedWorktreeId: "wt-a",
      selectedWorktreeStatusOverride: makeSummary("running", "thread-a"),
      activeThreadIdsByWorktreeId: {},
    })).toEqual({
      "wt-a": makeSummary("running", "thread-a"),
    });
  });

  it("removes the selected worktree override when the selected thread returns to idle", () => {
    expect(reconcileWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("waiting_approval", "thread-a"),
      },
      selectedWorktreeId: "wt-a",
      selectedWorktreeStatusOverride: null,
      activeThreadIdsByWorktreeId: {},
    })).toEqual({});
  });

  it("keeps the current worktree override when another thread in the same worktree is still active", () => {
    expect(reconcileWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("running", "thread-running"),
      },
      selectedWorktreeId: "wt-a",
      selectedWorktreeStatusOverride: null,
      activeThreadIdsByWorktreeId: {
        "wt-a": new Set<string>(["thread-running"]),
      },
    })).toEqual({
      "wt-a": makeSummary("running", "thread-running"),
    });
  });
});

describe("pruneSettledWorktreeStatusOverrides", () => {
  it("removes a stale running override after background status settles idle", () => {
    expect(pruneSettledWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("running", "thread-a"),
      },
      selectedWorktreeId: "wt-b",
      statusSnapshotsByThreadId: {
        "thread-a": {
          status: "idle",
          newestIdx: 1,
        },
      },
      activeThreadIds: new Set<string>(),
      selectedWorktreeStatusOverride: null,
    })).toEqual({});
  });

  it("keeps a background override while the same thread snapshot still matches", () => {
    expect(pruneSettledWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("waiting_approval", "thread-a"),
      },
      selectedWorktreeId: "wt-b",
      statusSnapshotsByThreadId: {
        "thread-a": {
          status: "waiting_approval",
          newestIdx: 3,
        },
      },
      activeThreadIds: new Set<string>(),
      selectedWorktreeStatusOverride: null,
    })).toEqual({
      "wt-a": makeSummary("waiting_approval", "thread-a"),
    });
  });

  it("keeps a background override while the thread is still active even if the snapshot is stale", () => {
    expect(pruneSettledWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("running", "thread-a"),
      },
      selectedWorktreeId: "wt-b",
      statusSnapshotsByThreadId: {
        "thread-a": {
          status: "idle",
          newestIdx: 2,
        },
      },
      activeThreadIds: new Set<string>(["thread-a"]),
      selectedWorktreeStatusOverride: null,
    })).toEqual({
      "wt-a": makeSummary("running", "thread-a"),
    });
  });

  it("keeps a background override while the thread snapshot has not arrived yet", () => {
    expect(pruneSettledWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("running", "thread-a"),
      },
      selectedWorktreeId: "wt-b",
      statusSnapshotsByThreadId: {},
      activeThreadIds: new Set<string>(),
      selectedWorktreeStatusOverride: null,
    })).toEqual({
      "wt-a": makeSummary("running", "thread-a"),
    });
  });

  it("clears a selected-worktree sibling override once the selected thread is idle and the running sibling settles", () => {
    expect(pruneSettledWorktreeStatusOverrides({
      current: {
        "wt-a": makeSummary("running", "thread-running"),
      },
      selectedWorktreeId: "wt-a",
      statusSnapshotsByThreadId: {
        "thread-running": {
          status: "idle",
          newestIdx: 5,
        },
      },
      activeThreadIds: new Set<string>(),
      selectedWorktreeStatusOverride: null,
    })).toEqual({});
  });
});
