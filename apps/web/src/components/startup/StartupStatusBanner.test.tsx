import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StartupStatusBanner } from "./StartupStatusBanner";

describe("StartupStatusBanner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders nothing while runtime is reconnecting", () => {
    act(() => {
      root.render(
        <StartupStatusBanner
          runtimeState="reconnecting"
          snapshot={{
            version: 1,
            capturedAt: "2026-05-19T12:00:00.000Z",
            repoId: "repo-1",
            repoName: "Repo One",
            worktreeId: "wt-1",
            worktreeBranch: "main",
            worktreePath: "/tmp/repo",
            worktreeStatus: "active",
            threadId: "thread-1",
            threadTitle: "Fix startup",
            threadStatus: "idle",
          }}
        />,
      );
    });

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when runtime is ready", () => {
    act(() => {
      root.render(
        <StartupStatusBanner
          runtimeState="ready"
          snapshot={{
            version: 1,
            capturedAt: "2026-05-19T12:00:00.000Z",
            repoId: "repo-1",
            repoName: "Repo One",
            worktreeId: "wt-1",
            worktreeBranch: "main",
            worktreePath: "/tmp/repo",
            worktreeStatus: "active",
            threadId: "thread-1",
            threadTitle: "Fix startup",
            threadStatus: "idle",
          }}
        />,
      );
    });

    expect(container.innerHTML).toBe("");
  });
});
