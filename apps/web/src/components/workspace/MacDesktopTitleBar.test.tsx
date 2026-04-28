import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacDesktopTitleBar } from "./MacDesktopTitleBar";

const tauriWindowMocks = vi.hoisted(() => ({
  startDragging: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  isFullscreen: vi.fn(async () => false),
  resizedHandlers: new Set<() => void>(),
  movedHandlers: new Set<() => void>(),
  scaleChangedHandlers: new Set<() => void>(),
  focusChangedHandlers: new Set<(event: { payload: boolean }) => void>(),
  onResized: vi.fn(async (handler: () => void) => {
    tauriWindowMocks.resizedHandlers.add(handler);
    return () => tauriWindowMocks.resizedHandlers.delete(handler);
  }),
  onMoved: vi.fn(async (handler: () => void) => {
    tauriWindowMocks.movedHandlers.add(handler);
    return () => tauriWindowMocks.movedHandlers.delete(handler);
  }),
  onScaleChanged: vi.fn(async (handler: () => void) => {
    tauriWindowMocks.scaleChangedHandlers.add(handler);
    return () => tauriWindowMocks.scaleChangedHandlers.delete(handler);
  }),
  onFocusChanged: vi.fn(async (handler: (event: { payload: boolean }) => void) => {
    tauriWindowMocks.focusChangedHandlers.add(handler);
    return () => tauriWindowMocks.focusChangedHandlers.delete(handler);
  }),
  emitResized: () => {
    for (const handler of tauriWindowMocks.resizedHandlers) {
      handler();
    }
  },
  emitFocusChanged: (focused: boolean) => {
    for (const handler of tauriWindowMocks.focusChangedHandlers) {
      handler({ payload: focused });
    }
  },
  resetWindowEventHandlers: () => {
    tauriWindowMocks.resizedHandlers.clear();
    tauriWindowMocks.movedHandlers.clear();
    tauriWindowMocks.scaleChangedHandlers.clear();
    tauriWindowMocks.focusChangedHandlers.clear();
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: tauriWindowMocks.startDragging,
    toggleMaximize: tauriWindowMocks.toggleMaximize,
    isFullscreen: tauriWindowMocks.isFullscreen,
    onResized: tauriWindowMocks.onResized,
    onMoved: tauriWindowMocks.onMoved,
    onScaleChanged: tauriWindowMocks.onScaleChanged,
    onFocusChanged: tauriWindowMocks.onFocusChanged,
  }),
}));

vi.mock("../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

describe("MacDesktopTitleBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    tauriWindowMocks.startDragging.mockClear();
    tauriWindowMocks.toggleMaximize.mockClear();
    tauriWindowMocks.isFullscreen.mockReset();
    tauriWindowMocks.isFullscreen.mockResolvedValue(false);
    tauriWindowMocks.onResized.mockClear();
    tauriWindowMocks.onMoved.mockClear();
    tauriWindowMocks.onScaleChanged.mockClear();
    tauriWindowMocks.onFocusChanged.mockClear();
    tauriWindowMocks.resetWindowEventHandlers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
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

  async function flushWindowStateSync() {
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders a centered app title", () => {
    renderTitleBar();

    expect(container.textContent).toContain("CodeSymphony");
    expect(container.querySelector('[data-testid="mac-titlebar-drag-surface"]')).not.toBeNull();
  });

  it("stays visible for desktop app layout overrides below responsive breakpoints", () => {
    renderTitleBar({ desktopApp: true });

    const dragSurface = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-drag-surface"]');
    if (!dragSurface) {
      throw new Error("Drag surface not found");
    }

    expect(dragSurface.className).toContain("block");
    expect(dragSurface.className).not.toContain("hidden lg:block");
  });

  it("requests Tauri window dragging for non-interactive titlebar clicks", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    renderTitleBar();
    await flushWindowStateSync();

    const dragSurface = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-drag-surface"]');
    if (!dragSurface) {
      throw new Error("Drag surface not found");
    }

    await act(async () => {
      dragSurface.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
    });

    expect(tauriWindowMocks.startDragging).toHaveBeenCalledTimes(1);
    expect(tauriWindowMocks.toggleMaximize).not.toHaveBeenCalled();
  });

  it("requests Tauri zoom toggle for titlebar double clicks", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    renderTitleBar();
    await flushWindowStateSync();

    const dragSurface = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-drag-surface"]');
    if (!dragSurface) {
      throw new Error("Drag surface not found");
    }

    await act(async () => {
      dragSurface.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
    });

    expect(tauriWindowMocks.toggleMaximize).toHaveBeenCalledTimes(1);
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

  it("shifts titlebar controls to the left edge in fullscreen and restores them after exit", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    renderTitleBar();
    await flushWindowStateSync();

    const dragSurface = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-drag-surface"]');
    const controls = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-controls"]');
    if (!dragSurface || !controls) {
      throw new Error("Titlebar elements not found");
    }

    expect(dragSurface.dataset.titlebarLayout).toBe("windowed");
    expect(controls.className).toContain("pl-[82px]");

    tauriWindowMocks.isFullscreen.mockResolvedValue(true);
    tauriWindowMocks.emitResized();
    await flushWindowStateSync();

    expect(dragSurface.dataset.titlebarLayout).toBe("fullscreen");
    expect(controls.className).toContain("pl-3");
    expect(controls.className).not.toContain("pl-[82px]");

    tauriWindowMocks.isFullscreen.mockResolvedValue(false);
    tauriWindowMocks.emitFocusChanged(true);
    await flushWindowStateSync();

    expect(dragSurface.dataset.titlebarLayout).toBe("windowed");
    expect(controls.className).toContain("pl-[82px]");
  });
});
