import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "@codesymphony/shared-types";
import { WorkspaceHeader } from "./WorkspaceHeader";

vi.mock("./OpenInAppButton", () => ({
  OpenInAppButton: () => null,
}));

const threads: ChatThread[] = [
  {
    id: "thread-1",
    worktreeId: "wt-1",
    title: "New Thread",
    kind: "default",
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-02-28T00:00:00.000Z",
    updatedAt: "2026-02-28T00:00:00.000Z",
  },
  {
    id: "thread-2",
    worktreeId: "wt-1",
    title: "Secondary Thread",
    kind: "default",
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-02-28T00:00:00.000Z",
    updatedAt: "2026-02-28T00:00:00.000Z",
  },
];

function noop() {}

describe("WorkspaceHeader", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  function renderHeader(overrides?: Partial<Parameters<typeof WorkspaceHeader>[0]>) {
    const props: Parameters<typeof WorkspaceHeader>[0] = {
      selectedRepositoryName: "repo",
      selectedWorktreeLabel: "main",
      worktreePath: "/tmp/repo",
      threads,
      selectedThreadId: "thread-1",
      fileTabs: [],
      activeFilePath: null,
      disabled: false,
      createThreadDisabled: false,
      closingThreadId: null,
      protectedThreadId: null,
      onSelectThread: noop,
      onSelectFileTab: noop,
      onPinFileTab: noop,
      onCloseFileTab: noop,
      onCreateThread: noop,
      onCloseThread: noop,
      onRenameThread: noop,
    };

    flushSync(() => {
      root.render(<WorkspaceHeader {...props} {...overrides} />);
    });
  }

  it("renames selected thread via double-click then Enter", async () => {
    const onRenameThread = vi.fn();
    renderHeader({ onRenameThread });

    const selectedTab = container.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="true"]');
    if (!selectedTab) {
      throw new Error("Selected tab not found");
    }

    flushSync(() => {
      selectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename thread title"]');
    if (!input) {
      throw new Error("Rename input not found");
    }

    flushSync(() => {
      input.value = "  Summarize setup docs  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await Promise.resolve();

    expect(onRenameThread).toHaveBeenCalledTimes(1);
    expect(onRenameThread).toHaveBeenCalledWith("thread-1", "Summarize setup docs");
  });

  it("cancels rename on Escape", () => {
    const onRenameThread = vi.fn();
    renderHeader({ onRenameThread });

    const selectedTab = container.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="true"]');
    if (!selectedTab) {
      throw new Error("Selected tab not found");
    }

    flushSync(() => {
      selectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename thread title"]');
    if (!input) {
      throw new Error("Rename input not found");
    }

    flushSync(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelector('input[aria-label="Rename thread title"]')).toBeNull();
    expect(onRenameThread).not.toHaveBeenCalled();
  });

  it("does not enter rename mode for unselected thread", () => {
    renderHeader({ selectedThreadId: "thread-1" });

    const unselectedTab = container.querySelector<HTMLButtonElement>('button[role="tab"][title="Secondary Thread"]');
    if (!unselectedTab) {
      throw new Error("Unselected tab not found");
    }

    flushSync(() => {
      unselectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(container.querySelector('input[aria-label="Rename thread title"]')).toBeNull();
  });

  it("uses the same button background styling for run and stop states", () => {
    renderHeader({ runScriptRunning: false, onToggleRunScript: noop });

    const runButton = container.querySelector<HTMLButtonElement>('button[aria-label="Run script"]');
    if (!runButton) {
      throw new Error("Run button not found");
    }

    const runClassName = runButton.className;

    renderHeader({ runScriptRunning: true, onToggleRunScript: noop });

    const stopButton = container.querySelector<HTMLButtonElement>('button[aria-label="Stop script"]');
    if (!stopButton) {
      throw new Error("Stop button not found");
    }

    expect(stopButton.className).toBe(runClassName);
  });

  it("keeps add session button pinned outside scroll area", () => {
    const onCreateThread = vi.fn();
    renderHeader({ onCreateThread });

    const scrollRegion = container.querySelector('[data-testid="session-tabs-scroll"]');
    if (!(scrollRegion instanceof HTMLDivElement)) {
      throw new Error("Session tab scroll region not found");
    }

    const addSessionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add session"]');
    if (!addSessionButton) {
      throw new Error("Add session button not found");
    }

    expect(scrollRegion.contains(addSessionButton)).toBe(false);

    flushSync(() => {
      addSessionButton.click();
    });

    expect(onCreateThread).toHaveBeenCalledTimes(1);
  });

  it("renders runtime and worktree context metadata", () => {
    renderHeader({
      runtimeLabel: "Desktop runtime :4322",
      runtimeTitle: "Runtime cwd: /bundle/runtime\nDatabase: /db.sqlite",
      worktreePath: "/tmp/repo",
    });

    const runtimeContext = container.querySelector<HTMLElement>('[data-testid="workspace-runtime-context"]');
    const worktreePath = container.querySelector<HTMLElement>('[data-testid="workspace-worktree-path"]');

    expect(runtimeContext?.textContent).toContain("Desktop runtime :4322");
    expect(runtimeContext?.getAttribute("title")).toContain("Runtime cwd: /bundle/runtime");
    expect(worktreePath?.textContent).toContain("/tmp/repo");
  });

  it("keeps unselected close buttons non-interactive until hovered", () => {
    renderHeader({ selectedThreadId: "thread-1" });

    const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close session Secondary Thread"]');
    if (!closeButton) {
      throw new Error("Unselected close button not found");
    }

    expect(closeButton.className).toContain("pointer-events-none");
    expect(closeButton.disabled).toBe(false);
  });

  it("renders file tabs and routes close/select actions", () => {
    const onSelectFileTab = vi.fn();
    const onPinFileTab = vi.fn();
    const onCloseFileTab = vi.fn();
    renderHeader({
      activeFilePath: "src/editor.tsx",
      fileTabs: [{ path: "src/editor.tsx", dirty: true, pinned: false }],
      onSelectFileTab,
      onPinFileTab,
      onCloseFileTab,
    });

    const fileTab = container.querySelector<HTMLButtonElement>('button[role="tab"][title="src/editor.tsx"]');
    const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close file editor.tsx"]');
    if (!fileTab || !closeButton) {
      throw new Error("File tab controls not found");
    }

    expect(fileTab.className).toContain("italic");

    flushSync(() => {
      fileTab.click();
      fileTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      closeButton.click();
    });

    expect(container.textContent).toContain("editor.tsx");
    expect(onSelectFileTab).toHaveBeenCalledWith("src/editor.tsx");
    expect(onPinFileTab).toHaveBeenCalledWith("src/editor.tsx");
    expect(onCloseFileTab).toHaveBeenCalledWith("src/editor.tsx");
  });

  it("uses the same simple active-tab styling for the review tab", () => {
    renderHeader({ showReviewTab: true, reviewTabActive: true });

    const reviewTab = container.querySelector<HTMLDivElement>('button[aria-label="Close review tab"]')?.parentElement;
    if (!reviewTab) {
      throw new Error("Review tab container not found");
    }

    expect(reviewTab.className).toContain("border-b-primary");
    expect(reviewTab.className).not.toContain("rounded-t-md");
    expect(reviewTab.className).not.toContain("shadow-[inset_0_2px_0_0_#4cc2ff]");
    expect(reviewTab.className).not.toContain("bg-[#1f1f1f]");
  });

  it("disables all close buttons while a thread is closing", () => {
    renderHeader({ closingThreadId: "thread-1" });

    const selectedCloseButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close session New Thread"]');
    const secondaryCloseButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close session Secondary Thread"]');
    if (!selectedCloseButton || !secondaryCloseButton) {
      throw new Error("Close buttons not found");
    }

    expect(selectedCloseButton.disabled).toBe(true);
    expect(secondaryCloseButton.disabled).toBe(true);
  });

  it("disables the close button for a protected running thread", () => {
    renderHeader({ protectedThreadId: "thread-1" });

    const selectedCloseButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close session New Thread"]');
    if (!selectedCloseButton) {
      throw new Error("Selected close button not found");
    }

    expect(selectedCloseButton.disabled).toBe(true);
  });

});
