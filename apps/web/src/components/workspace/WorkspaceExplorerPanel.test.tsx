import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileEntry } from "@codesymphony/shared-types";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { resetMaterialIconThemeManifestCacheForTest } from "../../lib/materialIconTheme";
import { WorkspaceExplorerPanel } from "./WorkspaceExplorerPanel";

vi.mock("../../lib/api", () => ({
  api: {
    getWorktreeDirectoryEntries: vi.fn(),
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
let scrollIntoViewMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  scrollIntoViewMock = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  vi.mocked(api.getWorktreeDirectoryEntries).mockReset();
  resetMaterialIconThemeManifestCacheForTest();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  container.remove();
});

describe("WorkspaceExplorerPanel", () => {
  it("auto-expands parent folders for the active file and marks it as current", async () => {
    const entries: FileEntry[] = [
      { path: "docs/guides/intro.md", type: "file" },
      { path: "docs/guides/advanced.md", type: "file" },
      { path: "src/main.ts", type: "file" },
    ];

    act(() => {
      root.render(
        <WorkspaceExplorerPanel
          entries={entries}
          gitEntries={[]}
          loading={false}
          activeFilePath="docs/guides/intro.md"
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const activeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.dataset.explorerPath === "docs/guides/intro.md");

    expect(container.textContent).toContain("docs");
    expect(container.textContent).toContain("guides");
    expect(container.textContent).toContain("intro.md");
    expect(activeButton?.getAttribute("aria-current")).toBe("page");
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("loads directory entries from the worktree tree API so gitignored files appear", async () => {
    vi.mocked(api.getWorktreeDirectoryEntries).mockImplementation(async (_worktreeId, directoryPath) => {
      if (!directoryPath) {
        return [
          { path: "ignored", type: "directory" },
          { path: "secret.txt", type: "file" },
        ];
      }

      if (directoryPath === "ignored") {
        return [{ path: "ignored/cache.json", type: "file" }];
      }

      return [];
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceExplorerPanel
            worktreeId="wt-1"
            gitEntries={[]}
            activeFilePath="ignored/cache.json"
            onOpenFile={vi.fn()}
            onClose={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const activeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.dataset.explorerPath === "ignored/cache.json");

    expect(container.textContent).toContain("ignored");
    expect(container.textContent).toContain("cache.json");
    expect(container.textContent).toContain("secret.txt");
    expect(activeButton?.getAttribute("aria-current")).toBe("page");
    expect(api.getWorktreeDirectoryEntries).toHaveBeenCalledWith("wt-1", undefined, expect.any(AbortSignal));
    expect(api.getWorktreeDirectoryEntries).toHaveBeenCalledWith("wt-1", "ignored", expect.any(AbortSignal));
  });

  it("shows a skeleton and skips directory queries while the worktree is pending", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceExplorerPanel
            worktreeId="wt-1"
            gitEntries={[]}
            pending
            activeFilePath={null}
            onOpenFile={vi.fn()}
            onClose={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='pending-worktree-explorer-skeleton']")).toBeTruthy();
    expect(api.getWorktreeDirectoryEntries).not.toHaveBeenCalled();
  });
});
