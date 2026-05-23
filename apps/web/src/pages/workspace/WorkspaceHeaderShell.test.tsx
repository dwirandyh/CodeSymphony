import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHeaderShell } from "./WorkspaceHeaderShell";

describe("WorkspaceHeaderShell", () => {
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

  function renderShell(overrides?: Partial<Parameters<typeof WorkspaceHeaderShell>[0]>) {
    const props: Parameters<typeof WorkspaceHeaderShell>[0] = {
      selectedWorktreeBranch: "feature/instant-open",
      targetBranch: "main",
      selectedTabLabel: "Instant open thread",
      leftPanelVisible: true,
    };

    flushSync(() => {
      root.render(<WorkspaceHeaderShell {...props} {...overrides} />);
    });
  }

  it("renders shell-ready branch and tab labels", () => {
    renderShell();

    expect(container.querySelector('[data-testid="workspace-header-shell-fallback"]')?.textContent).toContain("feature/instant-open");
    expect(container.textContent).toContain("origin/main");
    expect(container.textContent).toContain("Instant open thread");
  });

  it("keeps left panel toggle interactive while full header chunk loads", () => {
    const onToggleLeftPanel = vi.fn();
    renderShell({
      onToggleLeftPanel,
      leftPanelVisible: false,
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Show left panel"]');
    if (!button) {
      throw new Error("Left panel toggle not found");
    }

    flushSync(() => {
      button.click();
    });

    expect(onToggleLeftPanel).toHaveBeenCalledTimes(1);
  });

  it("falls back to root worktree label when branch missing", () => {
    renderShell({
      selectedWorktreeBranch: null,
      selectedIsRootWorkspace: true,
      targetBranch: null,
      selectedTabLabel: "",
    });

    expect(container.textContent).toContain("Root worktree");
    expect(container.textContent).toContain("Select target branch");
    expect(container.textContent).toContain("Chat");
  });
});
