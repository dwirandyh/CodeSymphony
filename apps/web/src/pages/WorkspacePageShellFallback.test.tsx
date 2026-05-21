import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacePageShellFallback } from "./WorkspacePageShellFallback";

describe("WorkspacePageShellFallback", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });

  function renderFallback(props: Parameters<typeof WorkspacePageShellFallback>[0]) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspacePageShellFallback {...props} />
        </QueryClientProvider>,
      );
    });
  }

  it("renders persisted workspace shell while full workspace logic loads", () => {
    renderFallback({
      activeView: "chat",
      panel: "git",
      runtimeState: "reconnecting",
      snapshot: {
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
      },
    });

    expect(container.textContent).toContain("CodeSymphony");
    expect(container.textContent).toContain("feat/instant-open");
    expect(container.textContent).toContain("Instant open");
    expect(container.textContent).toContain("Reconnecting to your recent messages.");
    expect(container.querySelector('[aria-label="Source Control"]')).not.toBeNull();
    expect(container.querySelector('[aria-placeholder="Message CodeSymphony... (type / or $ for commands, @ to mention files)"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Attach files"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Select permission mode"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Send message"]')).not.toBeNull();
  });

  it("renders the full persisted workspace list on the first frame", () => {
    renderFallback({
      activeView: "chat",
      panel: undefined,
      runtimeState: "restoring",
      snapshot: {
        version: 1,
        capturedAt: "2026-05-20T00:00:00.000Z",
        repoId: "repo-2",
        repoName: "Runtime",
        worktreeId: "wt-2",
        worktreeBranch: "feat/faster-shell",
        worktreePath: "/tmp/runtime",
        worktreeStatus: "active",
        threadId: "thread-2",
        threadTitle: "Hydration shell",
        threadStatus: "idle",
        repositories: [
          {
            id: "repo-1",
            name: "Web",
            rootPath: "/tmp/web",
            defaultBranch: "main",
            worktrees: [
              {
                id: "wt-1",
                repositoryId: "repo-1",
                branch: "feat/web-shell",
                path: "/tmp/web",
                baseBranch: "main",
                status: "active",
                branchRenamed: false,
              },
            ],
          },
          {
            id: "repo-2",
            name: "Runtime",
            rootPath: "/tmp/runtime",
            defaultBranch: "main",
            worktrees: [
              {
                id: "wt-2",
                repositoryId: "repo-2",
                branch: "feat/faster-shell",
                path: "/tmp/runtime",
                baseBranch: "main",
                status: "active",
                branchRenamed: false,
              },
            ],
          },
        ],
        expandedRepositoryIds: ["repo-1", "repo-2"],
      },
    });

    expect(container.textContent).toContain("Web");
    expect(container.textContent).toContain("Runtime");
    expect(container.textContent).toContain("feat/web-shell");
    expect(container.textContent).toContain("feat/faster-shell");
  });

  it("uses the selected file name when restoring file view", () => {
    renderFallback({
      activeView: "file",
      filePath: "apps/web/src/pages/WorkspacePage.tsx",
      panel: undefined,
      runtimeState: "restoring",
      snapshot: {
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
      },
    });

    expect(container.textContent).toContain("WorkspacePage.tsx");
    expect(container.textContent).toContain("apps/web/src/pages/WorkspacePage.tsx");
  });

  it("falls back to startup splash when no persisted shell exists", () => {
    renderFallback({
      activeView: "chat",
      panel: undefined,
      runtimeState: "ready",
      snapshot: null,
    });

    expect(container.textContent).toContain("Loading Workspace");
    expect(container.textContent).toContain("Preparing the editor");
  });
});
