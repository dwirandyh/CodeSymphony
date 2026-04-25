import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSearch } from "../../../routes/index";
import { useWorkspaceNavigationHistory } from "./useWorkspaceNavigationHistory";

let container: HTMLDivElement;
let root: Root;
let hookResult: ReturnType<typeof useWorkspaceNavigationHistory>;

function TestComponent({
  search,
  updateSearch,
}: {
  search: WorkspaceSearch;
  updateSearch: (partial: Partial<WorkspaceSearch>) => void;
}) {
  hookResult = useWorkspaceNavigationHistory({ search, updateSearch });
  return null;
}

function renderHook(search: WorkspaceSearch, updateSearch: (partial: Partial<WorkspaceSearch>) => void) {
  act(() => {
    root.render(<TestComponent search={search} updateSearch={updateSearch} />);
  });
}

describe("useWorkspaceNavigationHistory", () => {
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
    vi.restoreAllMocks();
  });

  it("does not record the initial auto-selected workspace as a back entry", () => {
    const updateSearch = vi.fn();

    renderHook({}, updateSearch);
    renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);

    expect(hookResult.canGoBack).toBe(false);
    expect(hookResult.canGoForward).toBe(false);
  });

  it("navigates backward and forward across meaningful workspace snapshots", () => {
    const updateSearch = vi.fn();

    renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);
    renderHook({
      repoId: "repo-1",
      worktreeId: "wt-1",
      threadId: "thread-1",
      view: "file",
      file: "src/App.tsx",
      fileLine: 14,
      fileColumn: 3,
    }, updateSearch);

    expect(hookResult.canGoBack).toBe(true);
    expect(hookResult.canGoForward).toBe(false);

    act(() => {
      hookResult.goBack();
    });

    expect(updateSearch).toHaveBeenLastCalledWith({
      repoId: "repo-1",
      worktreeId: "wt-1",
      threadId: undefined,
      view: undefined,
      file: undefined,
      fileLine: undefined,
      fileColumn: undefined,
    });

    renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);

    expect(hookResult.canGoBack).toBe(false);
    expect(hookResult.canGoForward).toBe(true);

    act(() => {
      hookResult.goForward();
    });

    expect(updateSearch).toHaveBeenLastCalledWith({
      repoId: "repo-1",
      worktreeId: "wt-1",
      threadId: "thread-1",
      view: "file",
      file: "src/App.tsx",
      fileLine: 14,
      fileColumn: 3,
    });
  });

  it("ignores panel-only changes", () => {
    const updateSearch = vi.fn();

    renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);
    renderHook({ repoId: "repo-1", worktreeId: "wt-1", panel: "git" }, updateSearch);

    expect(hookResult.canGoBack).toBe(false);
    expect(hookResult.canGoForward).toBe(false);
  });
});
