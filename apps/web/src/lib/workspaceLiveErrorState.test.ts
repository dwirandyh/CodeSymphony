import { describe, expect, it } from "vitest";
import { resolveWorkspaceLiveErrorSummary, type WorkspaceLiveStatusItem } from "./workspaceLiveErrorState";

function makeItem(
  overrides: Partial<WorkspaceLiveStatusItem> = {},
): WorkspaceLiveStatusItem {
  return {
    domain: "git_status",
    connectionState: "healthy",
    displayStateOverride: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("workspaceLiveErrorState", () => {
  it("ignores connecting and switching states", () => {
    expect(resolveWorkspaceLiveErrorSummary([
      makeItem({ connectionState: "connecting" }),
      makeItem({
        connectionState: "reconnecting",
        displayStateOverride: "switching",
      }),
      makeItem({ connectionState: "stale" }),
    ])).toBeNull();
  });

  it("surfaces unavailable worktrees as a single global error", () => {
    const result = resolveWorkspaceLiveErrorSummary([
      makeItem({
        connectionState: "exhausted",
        errorMessage: "Worktree path not found: /tmp/codesymphony",
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Selected workspace unavailable");
    expect(result?.description).toContain("Git status");
    expect(result?.description).toContain("Worktree path not found");
  });

  it("surfaces generic exhausted live updates as a single global error", () => {
    const result = resolveWorkspaceLiveErrorSummary([
      makeItem({
        domain: "chat_thread",
        connectionState: "exhausted",
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Live updates unavailable");
    expect(result?.description).toContain("Chat stream stopped receiving live updates.");
  });

  it("aggregates multiple failing live domains into one toast summary", () => {
    const result = resolveWorkspaceLiveErrorSummary([
      makeItem({
        domain: "git_status",
        connectionState: "exhausted",
        errorMessage: "Workspace live stream exhausted",
      }),
      makeItem({
        domain: "repository_reviews",
        connectionState: "exhausted",
        errorMessage: "Permission denied",
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Live updates unavailable");
    expect(result?.description).toContain("Git status: Workspace live stream exhausted");
    expect(result?.description).toContain("Repository reviews: Permission denied");
  });
});
