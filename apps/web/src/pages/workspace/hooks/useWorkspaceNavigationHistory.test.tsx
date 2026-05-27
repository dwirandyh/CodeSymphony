import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSearch } from "../../../routes/index";
import { useWorkspaceNavigationHistory } from "./useWorkspaceNavigationHistory";

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

async function renderHook(search: WorkspaceSearch, updateSearch: (partial: Partial<WorkspaceSearch>) => void) {
  await act(async () => {
    root.render(<TestComponent search={search} updateSearch={updateSearch} />);
    await Promise.resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("does not record the initial auto-selected workspace as a back entry", async () => {
    const updateSearch = vi.fn();

    await renderHook({}, updateSearch);
    await renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);

    expect(hookResult.canGoBack).toBe(false);
    expect(hookResult.canGoForward).toBe(false);
  });

  it("navigates backward and forward across meaningful workspace snapshots", async () => {
    const updateSearch = vi.fn();

    await renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);
    await renderHook({
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

    await renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);

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

  it("ignores panel-only changes", async () => {
    const updateSearch = vi.fn();

    await renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);
    await renderHook({ repoId: "repo-1", worktreeId: "wt-1", panel: "git" }, updateSearch);

    expect(hookResult.canGoBack).toBe(false);
    expect(hookResult.canGoForward).toBe(false);
  });

  it("records automations panel navigation as a meaningful workspace snapshot", async () => {
    const updateSearch = vi.fn();

    await renderHook({ repoId: "repo-1", worktreeId: "wt-1" }, updateSearch);
    await renderHook({
      repoId: "repo-1",
      worktreeId: "wt-1",
      view: "automations",
      automationId: "automation-1",
    }, updateSearch);

    expect(hookResult.canGoBack).toBe(true);

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
      automationId: undefined,
      automationCreate: undefined,
    });
  });
});
