import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileEntry } from "@codesymphony/shared-types";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { resetMaterialIconThemeManifestCacheForTest } from "../../lib/materialIconTheme";
import { WorkspaceExplorerPanel } from "./WorkspaceExplorerPanel";

vi.mock("../../lib/api", () => ({
  api: {
    getWorktreeDirectoryEntries: vi.fn(),
    copyWorktreePath: vi.fn(),
    moveWorktreePath: vi.fn(),
    pasteHostClipboardPaths: vi.fn(),
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
let scrollIntoViewMock: ReturnType<typeof vi.fn>;

function act(callback: () => void): void;
function act(callback: () => Promise<void>): Promise<void>;
function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });

  if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
    return result.then(() => Promise.resolve());
  }

  return undefined;
}

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
  vi.mocked(api.copyWorktreePath).mockReset();
  vi.mocked(api.moveWorktreePath).mockReset();
  vi.mocked(api.pasteHostClipboardPaths).mockReset();
  vi.mocked(api.copyWorktreePath).mockResolvedValue({ path: "src/README.md", type: "file" });
  vi.mocked(api.moveWorktreePath).mockResolvedValue({ path: "src/README.md", type: "file" });
  vi.mocked(api.pasteHostClipboardPaths).mockResolvedValue([{ path: "src/from-finder.txt", type: "file" }]);
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

    await vi.waitFor(() => {
      expect(container.textContent).toContain("intro.md");
    });

    const activeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.dataset.explorerPath === "docs/guides/intro.md");

    expect(container.textContent).toContain("docs");
    expect(container.textContent).toContain("guides");
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

    await vi.waitFor(() => {
      expect(container.textContent).toContain("cache.json");
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

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid='pending-worktree-explorer-skeleton']")).toBeTruthy();
    });

    expect(container.querySelector("[data-testid='pending-worktree-explorer-skeleton']")).toBeTruthy();
    expect(api.getWorktreeDirectoryEntries).not.toHaveBeenCalled();
  });

  it("renders untracked and ignored entries with muted explorer text", async () => {
    vi.mocked(api.getWorktreeDirectoryEntries).mockImplementation(async (_worktreeId, directoryPath) => {
      if (directoryPath) {
        return [];
      }

      return [
        { path: "src", type: "directory", sourceControlStatus: "tracked" },
        { path: "notes.md", type: "file", sourceControlStatus: "untracked" },
        { path: "secret.txt", type: "file", sourceControlStatus: "ignored" },
      ];
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceExplorerPanel
            worktreeId="wt-1"
            gitEntries={[]}
            activeFilePath={null}
            onOpenFile={vi.fn()}
            onClose={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("secret.txt");
    });

    const notesButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("notes.md"));
    const secretButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("secret.txt"));

    expect(notesButton?.className ?? "").toContain("text-muted-foreground/55");
    expect(secretButton?.className ?? "").toContain("text-muted-foreground/55");
  });

  it("copies an explorer entry and pastes it into a folder from the context menu", async () => {
    const entries: FileEntry[] = [
      { path: "README.md", type: "file" },
      { path: "src", type: "directory" },
    ];

    act(() => {
      root.render(
        <WorkspaceExplorerPanel
          worktreeId="wt-1"
          entries={entries}
          gitEntries={[]}
          loading={false}
          activeFilePath={null}
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("README.md");
    });

    function openContextMenu(label: string) {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent?.trim() === label);
      expect(button).toBeTruthy();
      act(() => {
        button!.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }));
      });
    }

    function selectMenuItem(label: string) {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent?.trim() === label);
      expect(button).toBeTruthy();
      act(() => {
        button!.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true,
        }));
      });
    }

    openContextMenu("README.md");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Rename");
    });
    selectMenuItem("Copy");

    openContextMenu("src");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Paste README.md");
    });
    selectMenuItem("Paste README.md");

    await vi.waitFor(() => {
      expect(api.copyWorktreePath).toHaveBeenCalledWith("wt-1", {
        sourcePath: "README.md",
        destinationDirectoryPath: "src",
      });
    });
  });

  it("pastes host clipboard files into a folder when no explorer clipboard entry exists", async () => {
    const entries: FileEntry[] = [
      { path: "src", type: "directory" },
    ];

    act(() => {
      root.render(
        <WorkspaceExplorerPanel
          worktreeId="wt-1"
          entries={entries}
          gitEntries={[]}
          loading={false}
          activeFilePath={null}
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("src");
    });

    const srcButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === "src");
    expect(srcButton).toBeTruthy();
    act(() => {
      srcButton!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
      }));
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Paste from Clipboard");
    });

    const pasteButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === "Paste from Clipboard");
    expect(pasteButton).toBeTruthy();
    act(() => {
      pasteButton!.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
      }));
    });

    await vi.waitFor(() => {
      expect(api.pasteHostClipboardPaths).toHaveBeenCalledWith("wt-1", {
        destinationDirectoryPath: "src",
      });
    });
  });
});
