import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "@codesymphony/shared-types";
import { WorkspaceHeader } from "./WorkspaceHeader";

const debugLogMock = vi.hoisted(() => vi.fn());

vi.mock("./OpenInAppButton", () => ({
  OpenInAppButton: () => null,
}));

vi.mock("../../lib/debugLog", () => ({
  debugLog: (...args: unknown[]) => debugLogMock(...args),
}));

vi.mock("../../lib/workspaceUiDiagnose", () => ({
  logWorkspaceUiIssueReportSignal: vi.fn(),
  probeSingleHeaderTabAlignment: vi.fn(),
  scheduleWorkspaceUiGeometryProbe: vi.fn(),
}));

function act(callback: () => void): void;
function act(callback: () => Promise<void>): Promise<void>;
function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  if (result && typeof (result as Promise<void>).then === "function") {
    return (result as Promise<void>).then(async () => {
      await Promise.resolve();
      flushSync(() => {});
    });
  }
  return undefined;
}

const threads: ChatThread[] = [
  {
    id: "thread-1",
    worktreeId: "wt-1",
    title: "New Thread",
    kind: "default",
    isAutomation: false,
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
    isAutomation: false,
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
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    localStorage.clear();
    container.remove();
    vi.clearAllMocks();
  });

  function renderHeader(overrides?: Partial<Parameters<typeof WorkspaceHeader>[0]>) {
    const props: Parameters<typeof WorkspaceHeader>[0] = {
      selectedWorktreeBranch: "main",
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

    act(() => {
      root.render(<WorkspaceHeader {...props} {...overrides} />);
    });
  }

  it("shows no session tabs when orderedTabs is an empty array", () => {
    renderHeader({ orderedTabs: [] });

    const tabs = container.querySelectorAll('button[role="tab"]');
    expect(tabs.length).toBe(0);
  });

  it("hides create session button when hideCreateSessionButton is true", () => {
    renderHeader({
      orderedTabs: [],
      threads: [],
      selectedThreadId: null,
      hideCreateSessionButton: true,
    });

    expect(container.querySelector('[data-testid="create-session-button"]')).toBeNull();
  });

  it("shows create session button when hideCreateSessionButton is false", () => {
    renderHeader({ hideCreateSessionButton: false });

    expect(container.querySelector('[data-testid="create-session-button"]')).not.toBeNull();
  });

  it("does not inject a pending thread tab when orderedTabs is empty but selection is stale", () => {
    renderHeader({
      orderedTabs: [],
      threads: [],
      selectedThreadId: "missing-thread",
      selectedThreadFallbackTitle: "Stale selection",
    });

    const tabs = container.querySelectorAll('button[role="tab"]');
    expect(tabs.length).toBe(0);
    expect(container.textContent).not.toContain("Stale selection");
    expect(container.textContent).not.toContain("Loading thread");
  });

  it("highlights the editor active tab when orderedTabs and editorActiveTabId are provided", () => {
    renderHeader({
      orderedTabs: [
        { type: "chat", id: "thread-1" },
        { type: "chat", id: "thread-2" },
      ],
      editorActiveTabId: "thread-2",
      selectedThreadId: "thread-1",
    });

    const selectedTab = container.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="true"]');
    expect(selectedTab?.title).toBe("Secondary Thread");
  });

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

  const terminalTabs = [
    { id: "term-1", title: "Terminal", sessionId: "wt-1:terminal:term-1" },
    { id: "term-2", title: "Terminal", sessionId: "wt-1:terminal:term-2" },
  ];

  it("renames selected terminal tab via double-click then Enter", async () => {
    const onRenameTerminalTab = vi.fn();
    renderHeader({
      terminalTabs,
      terminalTabActive: true,
      activeTerminalTabId: "term-1",
      onRenameTerminalTab,
    });

    const selectedTab = container.querySelector<HTMLButtonElement>(
      'button[role="tab"][title="Terminal"][aria-selected="true"]',
    );
    if (!selectedTab) {
      throw new Error("Selected terminal tab not found");
    }

    act(() => {
      selectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename terminal tab title"]');
    if (!input) {
      throw new Error("Terminal rename input not found");
    }

    await act(async () => {
      input.value = "  Build  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(onRenameTerminalTab).toHaveBeenCalledTimes(1);
    expect(onRenameTerminalTab).toHaveBeenCalledWith("term-1", "Build");
  });

  it("cancels terminal tab rename on Escape", () => {
    const onRenameTerminalTab = vi.fn();
    renderHeader({
      terminalTabs,
      terminalTabActive: true,
      activeTerminalTabId: "term-1",
      onRenameTerminalTab,
    });

    const selectedTab = container.querySelector<HTMLButtonElement>(
      'button[role="tab"][title="Terminal"][aria-selected="true"]',
    );
    if (!selectedTab) {
      throw new Error("Selected terminal tab not found");
    }

    act(() => {
      selectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename terminal tab title"]');
    if (!input) {
      throw new Error("Terminal rename input not found");
    }

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelector('input[aria-label="Rename terminal tab title"]')).toBeNull();
    expect(onRenameTerminalTab).not.toHaveBeenCalled();
  });

  it("does not enter rename mode for an unselected terminal tab", () => {
    renderHeader({
      terminalTabs,
      terminalTabActive: true,
      activeTerminalTabId: "term-1",
      onRenameTerminalTab: noop,
    });

    const unselectedTab = container.querySelector<HTMLButtonElement>(
      'button[role="tab"][title="Terminal"][aria-selected="false"]',
    );
    if (!unselectedTab) {
      throw new Error("Unselected terminal tab not found");
    }

    act(() => {
      unselectedTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(container.querySelector('input[aria-label="Rename terminal tab title"]')).toBeNull();
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

  it("renders the desktop left panel toggle button and routes clicks", () => {
    const onToggleLeftPanel = vi.fn();
    renderHeader({
      leftPanelVisible: true,
      onToggleLeftPanel,
    });

    const leftToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Hide left panel"]');
    if (!leftToggle) {
      throw new Error("Left panel toggle button not found");
    }

    act(() => {
      leftToggle.click();
    });

    expect(onToggleLeftPanel).toHaveBeenCalledTimes(1);
  });

  it("keeps the desktop control row visible for desktop app layout overrides", () => {
    renderHeader({ desktopApp: true });

    const desktopBar = container.querySelector<HTMLElement>('[data-testid="workspace-header-desktop-bar"]');
    if (!desktopBar) {
      throw new Error("Desktop header bar not found");
    }

    expect(desktopBar.className).toContain("flex");
    expect(desktopBar.className).not.toContain("hidden lg:flex");
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
    expect(container.querySelector('[data-testid="create-session-button"]')?.className).not.toContain("border");
    expect(container.querySelector('[data-testid="create-session-button"]')?.className).toContain("text-secondary-foreground");

    act(() => {
      addSessionButton.click();
    });

    expect(onCreateThread).toHaveBeenCalledTimes(1);
  });

  it("keeps a selected fallback thread tab visible while thread list catches up", () => {
    renderHeader({
      selectedThreadId: "thread-handoff",
      selectedThreadFallbackTitle: "Plan handoff",
    });

    const selectedTab = container.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="true"]');
    if (!selectedTab) {
      throw new Error("Selected fallback tab not found");
    }

    expect(selectedTab.textContent).toContain("Plan handoff");
    expect(selectedTab.title).toBe("Plan handoff");
    expect(container.querySelector('button[aria-label="Close session Plan handoff"]')).not.toBeNull();
  });

  it("recenters the selected thread tab when it renders too close to the tab-strip edge", async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const scrollIntoView = vi.fn();
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this instanceof HTMLDivElement && this.dataset.testid === "session-tabs-scroll") {
        return {
          x: 0,
          y: 0,
          width: 320,
          height: 40,
          top: 0,
          right: 320,
          bottom: 40,
          left: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }

      if (
        this instanceof HTMLButtonElement
        && this.getAttribute("role") === "tab"
        && this.getAttribute("aria-selected") === "true"
      ) {
        return {
          x: 260,
          y: 0,
          width: 140,
          height: 32,
          top: 0,
          right: 400,
          bottom: 32,
          left: 260,
          toJSON: () => ({}),
        } as DOMRect;
      }

      return originalGetBoundingClientRect.call(this);
    });

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderHeader();
      await Promise.resolve();

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
        inline: "center",
      });
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
      } else {
        // Match the pre-test environment when scrollIntoView is not defined.
        // @ts-expect-error -- test cleanup for environments without scrollIntoView
        delete HTMLElement.prototype.scrollIntoView;
      }
    }
  });

  it("remembers the last selected create action for the main add session button", async () => {
    const onCreateThread = vi.fn();
    const onCreateTerminal = vi.fn();
    renderHeader({ onCreateThread, onCreateTerminal, worktreePath: "/tmp/repo" });

    const menuButton = container.querySelector<HTMLButtonElement>('button[aria-label="Choose session type"]');
    const addSessionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add session"]');
    if (!menuButton || !addSessionButton) {
      throw new Error("Create session controls not found");
    }

    await act(async () => {
      menuButton.click();
      await Promise.resolve();
    });

    const terminalOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .find((button) => button.textContent?.includes("Terminal"));
    if (!terminalOption) {
      throw new Error("Terminal create option not found");
    }

    await act(async () => {
      terminalOption.click();
      await Promise.resolve();
    });

    expect(addSessionButton.textContent?.trim()).toBe("");

    act(() => {
      addSessionButton.click();
    });

    expect(onCreateThread).not.toHaveBeenCalled();
    expect(onCreateTerminal).toHaveBeenCalledTimes(2);
  });

  it("portals the create session menu outside the header tab strip", async () => {
    renderHeader({ worktreePath: "/tmp/repo" });

    const menuButton = container.querySelector<HTMLButtonElement>('button[aria-label="Choose session type"]');
    if (!menuButton) {
      throw new Error("Create session menu button not found");
    }

    await act(async () => {
      menuButton.click();
      await Promise.resolve();
    });

    const menu = document.body.querySelector<HTMLElement>('[data-testid="create-session-menu"]');
    const terminalOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .find((button) => button.textContent?.includes("Terminal"));
    if (!menu || !terminalOption) {
      throw new Error("Create session menu content not found");
    }

    const createSessionButton = container.querySelector<HTMLElement>('[data-testid="create-session-button"]');
    if (!createSessionButton) {
      throw new Error("Create session button container not found");
    }

    expect(document.body.contains(menu)).toBe(true);
    expect(createSessionButton.contains(menu)).toBe(false);
    expect(createSessionButton.contains(terminalOption)).toBe(false);
  });

  it("shows create session shortcuts only after opening the dropdown", async () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    renderHeader({ worktreePath: "/tmp/repo" });

    expect(document.body.textContent).not.toContain("⌘T");
    expect(document.body.textContent).not.toContain("⌘⇧T");

    const menuButton = container.querySelector<HTMLButtonElement>('button[aria-label="Choose session type"]');
    if (!menuButton) {
      throw new Error("Create session menu button not found");
    }

    await act(async () => {
      menuButton.click();
      await Promise.resolve();
    });

    const menu = document.body.querySelector<HTMLElement>('[data-testid="create-session-menu"]');
    const threadOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .find((button) => button.textContent?.includes("Thread"));
    expect(menu?.textContent).toContain("⌘T");
    expect(menu?.textContent).toContain("⌘⇧T");
    expect(threadOption?.querySelectorAll("svg")).toHaveLength(1);
  });

  it("renders an automation icon on automation thread tabs", () => {
    renderHeader({
      threads: [
        {
          ...threads[0],
          id: "thread-auto",
          title: "Nightly Audit",
          isAutomation: true,
        },
      ],
      selectedThreadId: "thread-auto",
    });

    expect(container.querySelector('[data-testid="thread-thread-auto-automation-icon"]')).not.toBeNull();
  });

  it("logs forced diagnostics when selected thread is missing from rendered thread tabs", async () => {
    await act(async () => {
      root.render(
        <WorkspaceHeader
          selectedWorktreeBranch="main"
          worktreePath="/repo"
          threads={threads.slice(0, 1)}
          selectedThreadId="missing-thread"
          selectedThreadFallbackTitle="Chat"
          fileTabs={[]}
          activeFilePath={null}
          disabled={false}
          closingThreadId={null}
          onSelectThread={noop}
          onSelectFileTab={noop}
          onPinFileTab={noop}
          onCloseFileTab={noop}
          onCreateThread={noop}
          onCloseThread={noop}
          onRenameThread={noop}
        />,
      );
      await Promise.resolve();
    });

    expect(debugLogMock).toHaveBeenCalledWith(
      "workspace.header.tabs",
      "tabs.state.changed",
      expect.objectContaining({
        selectedThreadId: "missing-thread",
        selectedThreadMissingFromTabs: true,
        sourceThreadIds: ["thread-1"],
        renderedThreadIds: ["thread-1", "missing-thread"],
      }),
      expect.objectContaining({
        force: true,
        threadId: "missing-thread",
      }),
    );
  });

  it("prefetches a thread when its tab is hovered or focused", () => {
    const onPrefetchThread = vi.fn();
    renderHeader({ onPrefetchThread });

    const secondaryTab = container.querySelector<HTMLButtonElement>('button[role="tab"][title="Secondary Thread"]');
    if (!secondaryTab) {
      throw new Error("Secondary thread tab not found");
    }

    act(() => {
      secondaryTab.dispatchEvent(new Event("pointerover", { bubbles: true }));
      secondaryTab.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(onPrefetchThread).toHaveBeenCalledTimes(2);
    expect(onPrefetchThread).toHaveBeenNthCalledWith(1, "thread-2");
    expect(onPrefetchThread).toHaveBeenNthCalledWith(2, "thread-2");
  });

  it("renders split tab strips full-width with add + history pinned on the tab row", () => {
    renderHeader({
      splitTabStrips: <div data-testid="split-strips-marker">split strips</div>,
    });

    const marker = container.querySelector('[data-testid="split-strips-marker"]');
    if (!marker) {
      throw new Error("Split strips slot not rendered");
    }

    expect(container.querySelector('[data-testid="session-tabs-scroll"]')).toBeNull();
    expect(container.querySelector('[data-testid="split-tab-strips-host"]')).not.toBeNull();

    const trailing = container.querySelector('[data-testid="split-tab-strips-trailing-controls"]');
    const addSessionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add session"]');
    const historyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Closed session history"]');
    expect(addSessionButton).not.toBeNull();
    expect(historyButton).not.toBeNull();
    expect(trailing?.contains(addSessionButton)).toBe(true);
    expect(trailing?.contains(historyButton)).toBe(true);
  });

  it("does not render runtime or worktree metadata rows", () => {
    renderHeader({ worktreePath: "/tmp/repo" });

    expect(container.querySelector('[data-testid="workspace-runtime-context"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-worktree-path"]')).toBeNull();
  });

  it("renders breadcrumb-style context and lets target branch be selected", async () => {
    const onSelectTargetBranch = vi.fn();
    renderHeader({
      selectedWorktreeBranch: "feature/root-sync",
      selectedIsRootWorkspace: true,
      targetBranch: "main",
      targetBranchOptions: ["main", "develop", "release/2026.04"],
      onSelectTargetBranch,
    });

    const context = container.querySelector<HTMLElement>('[data-testid="workspace-header-context"]');
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="workspace-target-branch-trigger"]');

    expect(context?.textContent).toBe("feature/root-sync");
    expect(trigger?.textContent).toContain("origin/main");

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="workspace-target-branch-filter"]');
    if (!filter) {
      throw new Error("Target branch filter not found");
    }

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (!valueSetter) {
        throw new Error("Input value setter not found");
      }
      valueSetter.call(filter, "release");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.body.querySelector('[data-testid="workspace-target-branch-option-develop"]')).toBeNull();

    const filteredOption = document.body.querySelector<HTMLButtonElement>('[data-testid="workspace-target-branch-option-release/2026.04"]');
    if (!filteredOption) {
      throw new Error("Filtered target branch option not found");
    }

    await act(async () => {
      filteredOption.click();
      await Promise.resolve();
    });

    expect(onSelectTargetBranch).toHaveBeenCalledWith("release/2026.04");
  });

  it("keeps the target branch selector available while branches are still loading", async () => {
    renderHeader({
      selectedWorktreeBranch: "feature/root-sync",
      targetBranch: "main",
      targetBranchOptions: [],
      targetBranchLoading: true,
      onSelectTargetBranch: vi.fn(),
    });

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="workspace-target-branch-trigger"]');

    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("origin/main");

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-testid="workspace-target-branch-filter"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="workspace-target-branch-empty"]')?.textContent).toContain("No branches found");
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

    act(() => {
      fileTab.click();
      fileTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      closeButton.click();
    });

    expect(container.textContent).toContain("editor.tsx");
    expect(onSelectFileTab).toHaveBeenCalledWith("src/editor.tsx");
    expect(onPinFileTab).toHaveBeenCalledWith("src/editor.tsx");
    expect(onCloseFileTab).toHaveBeenCalledWith("src/editor.tsx");
  });

  it("renders terminal tabs and routes select/close actions", () => {
    const onSelectTerminalTab = vi.fn();
    const onCloseTerminalTab = vi.fn();
    renderHeader({
      terminalTabs: [{ id: "terminal-1", title: "Terminal 2", sessionId: "wt-1:terminal:terminal-1" }],
      activeTerminalTabId: "terminal-1",
      terminalTabActive: true,
      onSelectTerminalTab,
      onCloseTerminalTab,
    });

    const terminalTab = container.querySelector<HTMLButtonElement>('button[role="tab"][title="Terminal 2"]');
    const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close terminal Terminal 2"]');
    if (!terminalTab || !closeButton) {
      throw new Error("Terminal tab controls not found");
    }

    act(() => {
      terminalTab.click();
      closeButton.click();
    });

    expect(onSelectTerminalTab).toHaveBeenCalledWith("terminal-1");
    expect(onCloseTerminalTab).toHaveBeenCalledWith("terminal-1");
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

  it("shows closed sessions in the history overlay with a reopen action", () => {
    const onReopenThread = vi.fn();
    const closedThread: ChatThread = {
      ...threads[0]!,
      id: "closed-thread",
      title: "Archived Chat",
      agent: "codex",
      tabOpen: false,
      updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    };

    renderHeader({ closedThreads: [closedThread], onReopenThread });

    const historyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Closed session history"]');
    if (!historyButton) {
      throw new Error("History button not found");
    }

    act(() => {
      historyButton.click();
    });

    const reopenButton = document.body.querySelector<HTMLButtonElement>('button[title="Reopen Archived Chat"]');
    if (!reopenButton) {
      throw new Error("Reopen action not found in overlay");
    }

    expect(document.body.textContent).toContain("Archived Chat");
    expect(document.body.textContent).toMatch(/\d+d ago/);

    act(() => {
      reopenButton.click();
    });

    expect(onReopenThread).toHaveBeenCalledWith("closed-thread");
  });

  it("does not list open threads in the history overlay", () => {
    renderHeader({ closedThreads: [] });

    const historyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Closed session history"]');
    if (!historyButton) {
      throw new Error("History button not found");
    }

    act(() => {
      historyButton.click();
    });

    expect(document.body.textContent).toContain("No closed sessions");
  });

});
