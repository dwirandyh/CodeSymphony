import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacePageShellFallback } from "./WorkspacePageShellFallback";

describe("WorkspacePageShellFallback", () => {
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

  it("renders persisted workspace shell while full workspace logic loads", () => {
    act(() => {
      root.render(
        <WorkspacePageShellFallback
          activeView="chat"
          panel="git"
          runtimeState="reconnecting"
          snapshot={{
            version: 1,
            capturedAt: "2026-05-20T00:00:00.000Z",
            repoId: "repo-1",
            repoName: "CodeSymphony",
            worktreeId: "wt-1",
            worktreeBranch: "feat/instant-open",
            worktreePath: "/tmp/codesymphony",
            worktreeStatus: "active",
            threadId: "thread-1",
            threadTitle: "Instant open",
            threadStatus: "idle",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("CodeSymphony");
    expect(container.textContent).toContain("feat/instant-open");
    expect(container.textContent).toContain("Instant open");
    expect(container.textContent).toContain("Reconnecting to local runtime");
    expect(container.querySelector('[data-testid="workspace-right-panel-shell"]')).not.toBeNull();
  });

  it("uses the selected file name when restoring file view", () => {
    act(() => {
      root.render(
        <WorkspacePageShellFallback
          activeView="file"
          filePath="apps/web/src/pages/WorkspacePage.tsx"
          panel={undefined}
          runtimeState="restoring"
          snapshot={{
            version: 1,
            capturedAt: "2026-05-20T00:00:00.000Z",
            repoId: "repo-1",
            repoName: "CodeSymphony",
            worktreeId: "wt-1",
            worktreeBranch: "feat/instant-open",
            worktreePath: "/tmp/codesymphony",
            worktreeStatus: "active",
            threadId: "thread-1",
            threadTitle: "Instant open",
            threadStatus: "idle",
          }}
        />,
      );
    });

    expect(container.querySelector('[data-testid="workspace-header-shell-fallback"]')?.textContent).toContain("WorkspacePage.tsx");
    expect(container.textContent).toContain("Restoring last workspace");
  });

  it("falls back to startup splash when no persisted shell exists", () => {
    act(() => {
      root.render(
        <WorkspacePageShellFallback
          activeView="chat"
          panel={undefined}
          runtimeState="ready"
          snapshot={null}
        />,
      );
    });

    expect(container.textContent).toContain("Loading Workspace");
    expect(container.textContent).toContain("Preparing the editor");
  });
});
