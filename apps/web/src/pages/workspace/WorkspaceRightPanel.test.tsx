import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRightPanel } from "./WorkspaceRightPanel";

vi.mock("../../components/workspace/DevicePanel", () => ({
  DevicePanel: () => <div>Device Panel Mock</div>,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("WorkspaceRightPanel", () => {
  it("toggles the device panel from the right rail", () => {
    const onUpdatePanel = vi.fn();

    act(() => {
      root.render(
        <WorkspaceRightPanel
          rightPanelId={null}
          worktreeId={null}
          gitChanges={{
            entries: [],
            branch: "main",
            upstream: null,
            loading: false,
            committing: false,
            syncing: false,
            canSync: false,
            ahead: 0,
            behind: 0,
            error: null,
            commit: vi.fn().mockResolvedValue(undefined),
            sync: vi.fn().mockResolvedValue(undefined),
            refresh: vi.fn().mockResolvedValue(undefined),
            discardChange: vi.fn().mockResolvedValue(undefined),
            getDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
          }}
          activeFilePath={null}
          selectedDiffFilePath={null}
          onOpenReview={() => {}}
          onSelectDiffFile={() => {}}
          onUpdatePanel={onUpdatePanel}
          onOpenReadFile={() => {}}
        />,
      );
    });

    const button = container.querySelector('button[aria-label="Devices"]');
    expect(button).toBeTruthy();

    act(() => {
      (button as HTMLButtonElement).click();
    });

    expect(onUpdatePanel).toHaveBeenCalledWith("device");
  });

  it("keeps the right rail visible for desktop app layout overrides", () => {
    act(() => {
      root.render(
        <WorkspaceRightPanel
          desktopApp={true}
          rightPanelId={null}
          worktreeId={null}
          gitChanges={{
            entries: [],
            branch: "main",
            upstream: null,
            loading: false,
            committing: false,
            syncing: false,
            canSync: false,
            ahead: 0,
            behind: 0,
            error: null,
            commit: vi.fn().mockResolvedValue(undefined),
            sync: vi.fn().mockResolvedValue(undefined),
            refresh: vi.fn().mockResolvedValue(undefined),
            discardChange: vi.fn().mockResolvedValue(undefined),
            getDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
          }}
          activeFilePath={null}
          selectedDiffFilePath={null}
          onOpenReview={() => {}}
          onSelectDiffFile={() => {}}
          onUpdatePanel={() => {}}
          onOpenReadFile={() => {}}
        />,
      );
    });

    const nav = container.querySelector("nav");
    if (!nav?.parentElement) {
      throw new Error("Right rail container not found");
    }

    expect(nav.parentElement.className).toContain("flex");
    expect(nav.parentElement.className).not.toContain("hidden lg:flex");
  });

  it("shields panel interactions while the right panel is being resized", () => {
    act(() => {
      root.render(
        <WorkspaceRightPanel
          rightPanelId="device"
          worktreeId={null}
          gitChanges={{
            entries: [],
            branch: "main",
            upstream: null,
            loading: false,
            committing: false,
            syncing: false,
            canSync: false,
            ahead: 0,
            behind: 0,
            error: null,
            commit: vi.fn().mockResolvedValue(undefined),
            sync: vi.fn().mockResolvedValue(undefined),
            refresh: vi.fn().mockResolvedValue(undefined),
            discardChange: vi.fn().mockResolvedValue(undefined),
            getDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
          }}
          activeFilePath={null}
          selectedDiffFilePath={null}
          onOpenReview={() => {}}
          onSelectDiffFile={() => {}}
          onUpdatePanel={() => {}}
          onOpenReadFile={() => {}}
        />,
      );
    });

    const resizeHandle = container.querySelector('button[aria-label="Resize right panel"]');
    expect(resizeHandle).toBeTruthy();

    act(() => {
      resizeHandle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 800 }));
    });

    const shield = container.querySelector('[data-resize-shield="true"]');
    expect(shield).toBeTruthy();

    const nav = container.querySelector("nav");
    expect(nav?.className).toContain("pointer-events-none");

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    expect(container.querySelector('[data-resize-shield="true"]')).toBeNull();
    expect(nav?.className).not.toContain("pointer-events-none");
  });
});
