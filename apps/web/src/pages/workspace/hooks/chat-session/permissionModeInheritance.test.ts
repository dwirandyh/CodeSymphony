import { describe, expect, it } from "vitest";
import type { ChatThread, ChatThreadPermissionMode } from "@codesymphony/shared-types";
import { resolveInheritedPermissionMode } from "./permissionModeInheritance";

function makeThread(params: {
  id: string;
  worktreeId?: string;
  permissionMode: ChatThreadPermissionMode;
  updatedAt: string;
  isAutomation?: boolean;
  kind?: ChatThread["kind"];
}): ChatThread {
  return {
    id: params.id,
    worktreeId: params.worktreeId ?? "wt-1",
    title: params.id,
    kind: params.kind ?? "default",
    isAutomation: params.isAutomation ?? false,
    permissionProfile: "default",
    permissionMode: params.permissionMode,
    mode: "default",
    updatedAt: params.updatedAt,
  } as ChatThread;
}

describe("resolveInheritedPermissionMode", () => {
  it("returns the mode of the most recently updated thread in the worktree", () => {
    const threads = [
      makeThread({ id: "old", permissionMode: "default", updatedAt: "2026-07-01T00:00:00.000Z" }),
      makeThread({ id: "new", permissionMode: "full_access", updatedAt: "2026-07-02T00:00:00.000Z" }),
    ];

    expect(resolveInheritedPermissionMode(threads, "wt-1")).toBe("full_access");
  });

  it("returns default when the newest thread was switched back to default", () => {
    const threads = [
      makeThread({ id: "old", permissionMode: "full_access", updatedAt: "2026-07-01T00:00:00.000Z" }),
      makeThread({ id: "new", permissionMode: "default", updatedAt: "2026-07-02T00:00:00.000Z" }),
    ];

    expect(resolveInheritedPermissionMode(threads, "wt-1")).toBe("default");
  });

  it("ignores threads from other worktrees", () => {
    const threads = [
      makeThread({ id: "other", worktreeId: "wt-2", permissionMode: "full_access", updatedAt: "2026-07-05T00:00:00.000Z" }),
      makeThread({ id: "mine", permissionMode: "default", updatedAt: "2026-07-01T00:00:00.000Z" }),
    ];

    expect(resolveInheritedPermissionMode(threads, "wt-1")).toBe("default");
  });

  it("ignores automation threads", () => {
    const threads = [
      makeThread({
        id: "automation",
        permissionMode: "full_access",
        updatedAt: "2026-07-05T00:00:00.000Z",
        isAutomation: true,
      }),
    ];

    expect(resolveInheritedPermissionMode(threads, "wt-1")).toBeNull();
  });

  it("ignores non-default thread kinds", () => {
    const threads = [
      makeThread({
        id: "review",
        permissionMode: "full_access",
        updatedAt: "2026-07-05T00:00:00.000Z",
        kind: "review",
      }),
    ];

    expect(resolveInheritedPermissionMode(threads, "wt-1")).toBeNull();
  });

  it("returns null when there is nothing to inherit from", () => {
    expect(resolveInheritedPermissionMode([], "wt-1")).toBeNull();
    expect(resolveInheritedPermissionMode([], null)).toBeNull();
  });
});
