import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRightPanelShell } from "./WorkspaceRightPanelShell";

describe("WorkspaceRightPanelShell", () => {
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

  function renderShell(overrides?: Partial<Parameters<typeof WorkspaceRightPanelShell>[0]>) {
    const props: Parameters<typeof WorkspaceRightPanelShell>[0] = {
      rightPanelId: null,
      gitChangeCount: 4,
      onUpdatePanel: vi.fn(),
    };

    act(() => {
      root.render(<WorkspaceRightPanelShell {...props} {...overrides} />);
    });
  }

  it("renders lightweight right rail buttons", () => {
    renderShell();

    expect(container.querySelector('button[aria-label="Explorer"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Source Control"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Devices"]')).toBeTruthy();
    expect(container.textContent).toContain("4");
  });

  it("keeps toggle buttons interactive before full chunk loads", () => {
    const onUpdatePanel = vi.fn();
    renderShell({ onUpdatePanel });

    const sourceControlButton = container.querySelector<HTMLButtonElement>('button[aria-label="Source Control"]');
    if (!sourceControlButton) {
      throw new Error("Source Control button not found");
    }

    act(() => {
      sourceControlButton.click();
    });

    expect(onUpdatePanel).toHaveBeenCalledWith("git");
  });

  it("shows panel loading shell when a panel is open", () => {
    renderShell({ rightPanelId: "device" });

    expect(container.textContent).toContain("Loading panel");
  });
});
