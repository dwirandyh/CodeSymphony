import { describe, expect, it } from "vitest";
import type { ChatThread } from "@codesymphony/shared-types";
import { pickStatusSnapshotCandidateIds } from "./worktreeStatusSnapshotCandidates";

function makeThread(id: string, updatedAt: string): ChatThread {
  return {
    id,
    worktreeId: "wt-1",
    title: id,
    kind: "default",
    isAutomation: false,
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    agent: "codex",
    model: "Xai/composer-2.5",
    modelProviderId: null,
    modelOptions: undefined,
    modelOptionsPerModel: undefined,
    handoffSourceThreadId: null,
    handoffSourcePlanEventId: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    opencodeSessionId: null,
    active: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
  };
}

describe("pickStatusSnapshotCandidateIds", () => {
  it("includes inactive threads that still have gate snapshots even when they are outside the recent inactive window", () => {
    const threads = [
      makeThread("t-recent-1", "2026-01-05T00:00:00Z"),
      makeThread("t-recent-2", "2026-01-04T00:00:00Z"),
      makeThread("t-gated-old", "2026-01-01T00:00:00Z"),
      makeThread("t-idle-old", "2026-01-02T00:00:00Z"),
    ];

    const candidateIds = pickStatusSnapshotCandidateIds(
      { "wt-1": threads },
      {
        "t-gated-old": { status: "waiting_approval", newestIdx: 3 },
      },
    );

    expect(new Set(candidateIds)).toEqual(new Set(["t-recent-1", "t-recent-2", "t-gated-old"]));
  });
});
