import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitChangeEntry } from "@codesymphony/shared-types";
import { MobileGitSheet, MobileMoreSheet, MobileUtilitiesSheet } from "./MobileWorkspaceNavigation";

vi.mock("./TerminalTab", () => ({
  TerminalTab: () => <div>Terminal</div>,
}));

let container: HTMLDivElement;
let root: Root;

function makeEntry(overrides: Partial<GitChangeEntry> = {}): GitChangeEntry {
  return {
    path: "src/index.ts",
    status: "modified",
    insertions: 3,
    deletions: 1,
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MobileGitSheet", () => {
  const baseProps = {
    open: true,
    onOpenChange: vi.fn(),
    entries: [makeEntry()],
    branch: "feature/mobile-git",
    loading: false,
    committing: false,
    syncing: false,
    canSync: false,
    ahead: 0,
    behind: 0,
    error: null,
    onCommit: vi.fn(),
    onSync: vi.fn(),
    onReview: vi.fn(),
    onRefresh: vi.fn(),
  };

  it("renders a compact summary instead of the old verbose cards", () => {
    act(() => {
      root.render(<MobileGitSheet {...baseProps} />);
    });

    expect(container.textContent).toContain("feature/mobile-git");
    expect(container.textContent).toContain("1 file");
    expect(container.textContent).toContain("1 modified");
    expect(container.textContent).toContain("+3");
    expect(container.textContent).toContain("-1");
    expect(container.textContent).not.toContain("Changed Files");
    expect(container.textContent).not.toContain("Line Delta");
    expect(container.textContent).not.toContain("Quick snapshot before review or commit.");
  });

  it("shows the PR/MR action button and wires the click handler on mobile", () => {
    const onPrMrAction = vi.fn();

    act(() => {
      root.render(
        <MobileGitSheet
          {...baseProps}
          reviewKind="pr"
          onPrMrAction={onPrMrAction}
        />
      );
    });

    const button = Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.includes("Create PR")
    );

    expect(button).toBeTruthy();

    act(() => {
      (button as HTMLButtonElement).click();
    });

    expect(onPrMrAction).toHaveBeenCalledTimes(1);
  });
});

describe("MobileMoreSheet", () => {
  it("renders a compact utilities hub and routes utility taps", () => {
    const onOpenUtility = vi.fn();

    act(() => {
      root.render(
        <MobileMoreSheet
          open
          onOpenChange={vi.fn()}
          hasWorktree
          runScriptActive
          onOpenRepositories={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenUtility={onOpenUtility}
        />,
      );
    });

    expect(container.textContent).toContain("Focused tools for setup, shell access, runs, and logs.");
    expect(container.textContent).toContain("Run Script");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).not.toContain("Inspect workspace setup and rerun initialization output.");

    const runButton = Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.includes("Run Script")
    );

    expect(runButton).toBeTruthy();

    act(() => {
      (runButton as HTMLButtonElement).click();
    });

    expect(onOpenUtility).toHaveBeenCalledWith("run");
  });
});

describe("MobileUtilitiesSheet", () => {
  it("renders a single utility detail shell with back navigation", () => {
    const onBack = vi.fn();

    act(() => {
      root.render(
        <MobileUtilitiesSheet
          open
          onOpenChange={vi.fn()}
          onBack={onBack}
          worktreeId="wt-1"
          worktreePath="/repo/demo-worktree"
          selectedThreadId="thread-1"
          scriptOutputs={[]}
          activeTab="run"
          onRerunSetup={vi.fn()}
          runScriptActive
          runScriptSessionId="wt-1:script-runner:active"
        />,
      );
    });

    expect(container.textContent).toContain("Utilities");
    expect(container.textContent).toContain("Run Script");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Attached to the live run session");
    expect(container.textContent).not.toContain("No run session is active for this worktree.");
    expect(container.textContent).not.toContain("Utility Detail");

    const backButton = Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.includes("Utilities")
    );

    expect(backButton).toBeTruthy();

    act(() => {
      (backButton as HTMLButtonElement).click();
    });

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("keeps the last run output visible after the run stops", () => {
    act(() => {
      root.render(
        <MobileUtilitiesSheet
          open
          onOpenChange={vi.fn()}
          onBack={vi.fn()}
          worktreeId="wt-1"
          worktreePath="/repo/demo-worktree"
          selectedThreadId="thread-1"
          scriptOutputs={[]}
          activeTab="run"
          onRerunSetup={vi.fn()}
          runScriptActive={false}
          runScriptSessionId="wt-1:script-runner:done"
        />,
      );
    });

    expect(container.textContent).toContain("Run Script");
    expect(container.textContent).toContain("Standby");
    expect(container.textContent).toContain("Terminal");
    expect(container.textContent).not.toContain("Start the run script from the workspace header to stream it here.");
  });
});
