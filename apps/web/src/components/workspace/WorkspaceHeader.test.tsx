import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
    title: "Main Thread",
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
    act(() => {
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
      disabled: false,
      createThreadDisabled: false,
      closingThreadId: null,
      onSelectThread: noop,
      onCreateThread: noop,
      onCloseThread: noop,
      onRenameThread: noop,
    };

    act(() => {
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

    act(() => {
      selectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename thread title"]');
    if (!input) {
      throw new Error("Rename input not found");
    }

    await act(async () => {
      input.value = "  Summarize setup docs  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

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

    act(() => {
      selectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename thread title"]');
    if (!input) {
      throw new Error("Rename input not found");
    }

    act(() => {
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

    act(() => {
      unselectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(container.querySelector('input[aria-label="Rename thread title"]')).toBeNull();
  });

  it("keeps add session button beside tabs inside scroll row", () => {
    const onCreateThread = vi.fn();
    renderHeader({ onCreateThread });

    const scrollRow = container.querySelector('[data-testid="session-tabs-scroll"] > div');
    if (!(scrollRow instanceof HTMLDivElement)) {
      throw new Error("Session tab row not found");
    }

    const addSessionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add session"]');
    if (!addSessionButton) {
      throw new Error("Add session button not found");
    }

    expect(scrollRow.contains(addSessionButton)).toBe(true);

    act(() => {
      addSessionButton.click();
    });

    expect(onCreateThread).toHaveBeenCalledTimes(1);
  });
});
