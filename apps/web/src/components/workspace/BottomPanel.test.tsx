import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomPanel } from "./BottomPanel";

vi.mock("./TerminalTab", () => ({
  TerminalTab: () => <div data-testid="mock-terminal">Terminal</div>,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BottomPanel", () => {
  const baseProps = {
    worktreeId: "w1",
    worktreePath: "/tmp/wt",
    selectedThreadId: "t1",
    scriptOutputs: [],
    activeTab: "terminal",
    collapsed: true,
    onTabChange: vi.fn(),
    onCollapsedChange: vi.fn(),
    runScriptActive: false,
    runScriptSessionId: null,
  };
  const findToggleButton = () => {
    const buttons = container.querySelectorAll("button");
    return Array.from(buttons).find(
      (b) => b.title === "Collapse panel" || b.title === "Expand panel"
    );
  };

  it("renders Setup Script, Terminal, Run, and Debug Console tab buttons", () => {
    act(() => {
      root.render(<BottomPanel {...baseProps} />);
    });
    expect(container.textContent).toContain("Setup Script");
    expect(container.textContent).toContain("Terminal");
    expect(container.textContent).toContain("Run");
    expect(container.textContent).toContain("Debug Console");
  });

  it("renders collapse/expand button", () => {
    act(() => {
      root.render(<BottomPanel {...baseProps} />);
    });
    const collapseBtn = findToggleButton();
    expect(collapseBtn).toBeTruthy();
  });

  it("starts collapsed on initial render", () => {
    act(() => {
      root.render(<BottomPanel {...baseProps} />);
    });
    const collapseBtn = findToggleButton();
    expect(collapseBtn?.title).toBe("Expand panel");
  });

  it("calls onTabChange when switching tabs", () => {
    const onTabChange = vi.fn();
    act(() => {
      root.render(<BottomPanel {...baseProps} onTabChange={onTabChange} />);
    });
    const buttons = container.querySelectorAll("button");
    const debugTab = Array.from(buttons).find((b) => b.textContent?.includes("Debug Console"));
    if (debugTab) {
      act(() => {
        debugTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      });
    }
    expect(onTabChange).toHaveBeenCalledWith("debug");
  });

  it("shows setup status chip without count when setup script outputs exist", () => {
    const scriptOutputs = [
      {
        id: "1",
        worktreeId: "w1",
        worktreeName: "branch",
        type: "setup" as const,
        timestamp: Date.now(),
        output: "done",
        success: true,
        status: "completed" as const,
      },
    ];
    act(() => {
      root.render(<BottomPanel {...baseProps} scriptOutputs={scriptOutputs} />);
    });
    expect(container.textContent).toContain("Setup Script");
    const chip = container.querySelector('[data-testid="setup-script-status-chip"]');
    expect(chip?.textContent).toContain("•");
    expect(chip?.textContent).not.toContain("1");
  });

  it("shows setup status chip in red when the latest setup result failed", () => {
    const scriptOutputs = [
      {
        id: "1",
        worktreeId: "w1",
        worktreeName: "branch",
        type: "setup" as const,
        timestamp: Date.now(),
        output: "failed",
        success: false,
        status: "completed" as const,
      },
    ];
    act(() => {
      root.render(<BottomPanel {...baseProps} scriptOutputs={scriptOutputs} />);
    });
    const chip = container.querySelector('[data-testid="setup-script-status-chip"]');
    expect(chip?.className).toContain("bg-destructive/20");
    expect(chip?.className).toContain("text-destructive");
  });

  it("shows run empty state when no run session is active", () => {
    act(() => {
      root.render(<BottomPanel {...baseProps} activeTab="run" />);
    });
    expect(container.textContent).toContain("No run session active.");
  });

  it("keeps rendering the last run session after it is no longer active", () => {
    act(() => {
      root.render(
        <BottomPanel
          {...baseProps}
          activeTab="run"
          runScriptSessionId="w1:script-runner:done"
        />,
      );
    });

    expect(container.textContent).toContain("Terminal");
    expect(container.textContent).not.toContain("No run session active.");
  });

  it("toggles collapsed state when collapse button clicked", () => {
    function ControlledBottomPanel() {
      const [collapsed, setCollapsed] = useState(true);

      return (
        <BottomPanel
          {...baseProps}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
        />
      );
    }

    act(() => {
      root.render(<ControlledBottomPanel />);
    });
    const collapseBtn = findToggleButton();
    if (collapseBtn) {
      act(() => collapseBtn.click());
      expect(collapseBtn.title).toBe("Collapse panel");
    }
  });

  it("expands when openSignal changes", () => {
    function ControlledBottomPanel({ openSignal }: { openSignal: number }) {
      const [collapsed, setCollapsed] = useState(true);

      return (
        <BottomPanel
          {...baseProps}
          openSignal={openSignal}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
        />
      );
    }

    act(() => {
      root.render(<ControlledBottomPanel openSignal={0} />);
    });
    expect(findToggleButton()?.title).toBe("Expand panel");

    act(() => {
      root.render(<ControlledBottomPanel openSignal={1} />);
    });
    expect(findToggleButton()?.title).toBe("Collapse panel");
  });

  it("does not auto-expand when switching to another worktree with a different stored signal", () => {
    const onCollapsedChange = vi.fn();

    act(() => {
      root.render(
        <BottomPanel
          {...baseProps}
          worktreeId="w1"
          collapsed={true}
          onCollapsedChange={onCollapsedChange}
          openSignal={3}
        />,
      );
    });

    onCollapsedChange.mockClear();

    act(() => {
      root.render(
        <BottomPanel
          {...baseProps}
          worktreeId="w2"
          collapsed={true}
          onCollapsedChange={onCollapsedChange}
          openSignal={0}
        />,
      );
    });

    expect(onCollapsedChange).not.toHaveBeenCalled();
    expect(findToggleButton()?.title).toBe("Expand panel");
  });
});
