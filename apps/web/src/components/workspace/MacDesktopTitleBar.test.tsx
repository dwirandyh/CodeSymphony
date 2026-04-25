import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacDesktopTitleBar } from "./MacDesktopTitleBar";

const startDraggingMock = vi.fn().mockResolvedValue(undefined);
const isFullscreenMock = vi.fn().mockResolvedValue(false);
const listenMock = vi.fn().mockResolvedValue(() => {});
const onResizedMock = vi.fn().mockResolvedValue(() => {});
const onFocusChangedMock = vi.fn().mockResolvedValue(() => {});
const onScaleChangedMock = vi.fn().mockResolvedValue(() => {});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging: startDraggingMock,
    isFullscreen: isFullscreenMock,
    listen: listenMock,
    onResized: onResizedMock,
    onFocusChanged: onFocusChangedMock,
    onScaleChanged: onScaleChangedMock,
  })),
}));

vi.mock("../../lib/openExternalUrl", async () => {
  const actual = await vi.importActual<typeof import("../../lib/openExternalUrl")>("../../lib/openExternalUrl");
  return {
    ...actual,
    isTauriDesktop: vi.fn(() => true),
  };
});

describe("MacDesktopTitleBar", () => {
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
    startDraggingMock.mockClear();
    isFullscreenMock.mockReset();
    isFullscreenMock.mockResolvedValue(false);
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    onResizedMock.mockClear();
    onResizedMock.mockResolvedValue(() => {});
    onFocusChangedMock.mockClear();
    onFocusChangedMock.mockResolvedValue(() => {});
    onScaleChangedMock.mockClear();
    onScaleChangedMock.mockResolvedValue(() => {});
  });

  function renderTitleBar(overrides?: Partial<Parameters<typeof MacDesktopTitleBar>[0]>) {
    const props: Parameters<typeof MacDesktopTitleBar>[0] = {
      appTitle: "CodeSymphony",
      canGoBack: true,
      canGoForward: true,
      leftPanelVisible: true,
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onToggleLeftPanel: vi.fn(),
    };

    act(() => {
      root.render(<MacDesktopTitleBar {...props} {...overrides} />);
    });

    return props;
  }

  it("renders a centered app title", () => {
    renderTitleBar();

    expect(container.textContent).toContain("CodeSymphony");
  });

  it("routes the left panel toggle", () => {
    const onToggleLeftPanel = vi.fn();
    renderTitleBar({ onToggleLeftPanel });

    const toggleButton = container.querySelector<HTMLButtonElement>('button[aria-label="Hide left panel"]');
    if (!toggleButton) {
      throw new Error("Left panel toggle button not found");
    }

    act(() => {
      toggleButton.click();
    });

    expect(onToggleLeftPanel).toHaveBeenCalledTimes(1);
  });

  it("routes back and forward actions to workspace navigation callbacks", () => {
    const onGoBack = vi.fn();
    const onGoForward = vi.fn();
    renderTitleBar({ onGoBack, onGoForward });

    const backButton = container.querySelector<HTMLButtonElement>('button[aria-label="Go back"]');
    if (!backButton) {
      throw new Error("Back button not found");
    }

    const forwardButton = container.querySelector<HTMLButtonElement>('button[aria-label="Go forward"]');
    if (!forwardButton) {
      throw new Error("Forward button not found");
    }

    act(() => {
      backButton.click();
      forwardButton.click();
    });

    expect(onGoBack).toHaveBeenCalledTimes(1);
    expect(onGoForward).toHaveBeenCalledTimes(1);
  });

  it("disables unavailable navigation actions", () => {
    const onGoBack = vi.fn();
    const onGoForward = vi.fn();
    renderTitleBar({
      canGoBack: false,
      canGoForward: false,
      onGoBack,
      onGoForward,
    });

    const backButton = container.querySelector<HTMLButtonElement>('button[aria-label="Go back"]');
    if (!backButton) {
      throw new Error("Back button not found");
    }

    const forwardButton = container.querySelector<HTMLButtonElement>('button[aria-label="Go forward"]');
    if (!forwardButton) {
      throw new Error("Forward button not found");
    }

    expect(backButton.disabled).toBe(true);
    expect(forwardButton.disabled).toBe(true);

    act(() => {
      backButton.click();
      forwardButton.click();
    });

    expect(onGoBack).not.toHaveBeenCalled();
    expect(onGoForward).not.toHaveBeenCalled();
  });

  it("starts dragging the desktop window from drag regions", () => {
    renderTitleBar();

    const titleRegion = container.querySelector<HTMLDivElement>('[data-testid="mac-titlebar-drag-surface"]');
    if (!titleRegion) {
      throw new Error("Title drag region not found");
    }

    act(() => {
      titleRegion.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });

    expect(startDraggingMock).toHaveBeenCalledTimes(1);
  });

  it("moves the controls cluster to the left edge in fullscreen", async () => {
    isFullscreenMock.mockResolvedValue(true);
    renderTitleBar();

    await act(async () => {
      await Promise.resolve();
    });

    const controls = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-controls"]');
    if (!controls) {
      throw new Error("Controls cluster not found");
    }

    expect(controls.className).toContain("left-3");
  });

  it("reacts to the native fullscreen event after mount", async () => {
    let fullscreenListener: ((event: { payload: boolean }) => void) | null = null;
    listenMock.mockImplementationOnce(async (_eventName, callback) => {
      fullscreenListener = callback as (event: { payload: boolean }) => void;
      return () => {};
    });

    renderTitleBar();

    await act(async () => {
      await Promise.resolve();
    });

    if (!fullscreenListener) {
      throw new Error("Fullscreen listener not registered");
    }

    await act(async () => {
      fullscreenListener?.({ payload: true });
      await Promise.resolve();
    });

    const controls = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-controls"]');
    if (!controls) {
      throw new Error("Controls cluster not found");
    }

    expect(controls.className).toContain("left-3");
  });
});
