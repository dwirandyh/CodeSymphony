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
    searchFiles: vi.fn(),
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function act(callback: () => void): void;
function act(callback: () => Promise<void>): Promise<void>;
function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
    return (result as Promise<void>).then(() => Promise.resolve());
  }
  return undefined;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.getWorktreeDirectoryEntries).mockReset();
  resetMaterialIconThemeManifestCacheForTest();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.textContent?.trim() === label);
}

describe("explorer expand-on-tap", () => {
  // Regression: tapping a folder is direct manipulation and must commit
  // immediately. When toggleDirectory was wrapped in startTransition the
  // update was deferred and could be starved by concurrent urgent renders
  // (SSE streaming / git polling) in a live workspace, so a tapped folder
  // appeared not to expand. This asserts the expansion is synchronous —
  // visible right after the click flush, with no waitFor.
  it("FLAT: expands a folder synchronously on tap", () => {
    const entries: FileEntry[] = [
      { path: "lib", type: "directory" },
      { path: "lib/util.ts", type: "file" },
      { path: "README.md", type: "file" },
    ];

    act(() => {
      root.render(
        <WorkspaceExplorerPanel
          entries={entries}
          gitEntries={[]}
          loading={false}
          activeFilePath={null}
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const libButton = findButton("lib");
    expect(libButton).toBeTruthy();
    expect(container.textContent).not.toContain("util.ts");

    act(() => {
      libButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // No waitFor: with startTransition this assertion fails because the
    // expand is deferred past the synchronous flush.
    expect(container.textContent).toContain("util.ts");
  });

  it("FLAT: collapses an expanded folder synchronously on tap", () => {
    const entries: FileEntry[] = [
      { path: "src", type: "directory" }, // src is a DEFAULT_EXPANDED_ROOT_PATH
      { path: "src/index.ts", type: "file" },
    ];

    act(() => {
      root.render(
        <WorkspaceExplorerPanel
          entries={entries}
          gitEntries={[]}
          loading={false}
          activeFilePath={null}
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    // src is expanded by default, so its child is visible.
    expect(container.textContent).toContain("index.ts");

    const srcButton = findButton("src");
    expect(srcButton).toBeTruthy();
    act(() => {
      srcButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("index.ts");
  });

  it("BRIDGE: expanding a folder triggers a directory fetch on tap", async () => {
    vi.mocked(api.getWorktreeDirectoryEntries).mockImplementation(async (_wt, directoryPath) => {
      if (!directoryPath) {
        return [{ path: "lib", type: "directory" }];
      }
      if (directoryPath === "lib") {
        return [{ path: "lib/util.ts", type: "file" }];
      }
      return [];
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

    await vi.waitFor(() => expect(findButton("lib")).toBeTruthy());
    expect(container.textContent).not.toContain("util.ts");

    act(() => {
      findButton("lib")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Bridge children load async via useQueries; waitFor is appropriate here.
    await vi.waitFor(() => {
      expect(container.textContent).toContain("util.ts");
    });
    expect(api.getWorktreeDirectoryEntries).toHaveBeenCalledWith("wt-1", "lib", expect.any(AbortSignal));
  });
});
