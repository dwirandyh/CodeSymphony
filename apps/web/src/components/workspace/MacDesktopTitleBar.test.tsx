import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacDesktopTitleBar } from "./MacDesktopTitleBar";

type DesktopTestWindow = Window & {
  __CS_ELECTRON__?: boolean;
  __CS_ELECTRON_BRIDGE__?: {
    startDragging: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    isFullscreen: () => Promise<boolean>;
    onWindowStateChanged: (handler: (state: { fullscreen?: boolean; maximized?: boolean }) => void) => () => void;
  };
};

const electronWindowMocks = vi.hoisted(() => ({
  startDragging: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => false),
  isFullscreen: vi.fn(async () => false),
  windowStateHandlers: new Set<(state: { fullscreen?: boolean; maximized?: boolean }) => void>(),
  onWindowStateChanged: vi.fn((handler: (state: { fullscreen?: boolean; maximized?: boolean }) => void) => {
    electronWindowMocks.windowStateHandlers.add(handler);
    return () => electronWindowMocks.windowStateHandlers.delete(handler);
  }),
  emitWindowStateChanged: (state: { fullscreen?: boolean; maximized?: boolean }) => {
    for (const handler of electronWindowMocks.windowStateHandlers) {
      handler(state);
    }
  },
  resetWindowEventHandlers: () => {
    electronWindowMocks.windowStateHandlers.clear();
  },
}));

vi.mock("../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

describe("MacDesktopTitleBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    electronWindowMocks.startDragging.mockClear();
    electronWindowMocks.toggleMaximize.mockClear();
    electronWindowMocks.isFullscreen.mockReset();
    electronWindowMocks.isFullscreen.mockResolvedValue(false);
    electronWindowMocks.onWindowStateChanged.mockClear();
    electronWindowMocks.resetWindowEventHandlers();
    delete (window as DesktopTestWindow).__CS_ELECTRON__;
    delete (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    delete (window as DesktopTestWindow).__CS_ELECTRON__;
    delete (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__;
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

  function installElectronBridge() {
    (window as DesktopTestWindow).__CS_ELECTRON__ = true;
    (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__ = {
      startDragging: electronWindowMocks.startDragging,
      toggleMaximize: electronWindowMocks.toggleMaximize,
      isFullscreen: electronWindowMocks.isFullscreen,
      onWindowStateChanged: electronWindowMocks.onWindowStateChanged,
    };
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

  it("requests Electron window dragging for non-interactive titlebar clicks", async () => {
    installElectronBridge();
    renderTitleBar();
    await flushWindowStateSync();

    const dragSurface = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-drag-surface"]');
    if (!dragSurface) {
      throw new Error("Drag surface not found");
    }

    await act(async () => {
      dragSurface.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
    });

    expect(electronWindowMocks.startDragging).toHaveBeenCalledTimes(1);
    expect(electronWindowMocks.toggleMaximize).not.toHaveBeenCalled();
  });

  it("requests Electron zoom toggle for titlebar double clicks", async () => {
    installElectronBridge();
    renderTitleBar();
    await flushWindowStateSync();

    const dragSurface = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-drag-surface"]');
    if (!dragSurface) {
      throw new Error("Drag surface not found");
    }

    await act(async () => {
      dragSurface.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
    });

    expect(electronWindowMocks.toggleMaximize).toHaveBeenCalledTimes(1);
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

  it("renders custom titlebar controls beside the navigation buttons", () => {
    renderTitleBar({
      resourceMonitor: <button type="button" data-testid="resource-monitor-trigger">Resource</button>,
    });

    const controls = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-controls"]');
    const trigger = container.querySelector<HTMLElement>('[data-testid="resource-monitor-trigger"]');
    if (!controls || !trigger) {
      throw new Error("Titlebar controls not found");
    }

    expect(controls.contains(trigger)).toBe(true);
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
    installElectronBridge();
    renderTitleBar();
    await flushWindowStateSync();

    const dragSurface = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-drag-surface"]');
    const controls = container.querySelector<HTMLElement>('[data-testid="mac-titlebar-controls"]');
    if (!dragSurface || !controls) {
      throw new Error("Titlebar elements not found");
    }

    expect(dragSurface.dataset.titlebarLayout).toBe("windowed");
    expect(controls.className).toContain("pl-[82px]");

    electronWindowMocks.isFullscreen.mockResolvedValue(true);
    electronWindowMocks.emitWindowStateChanged({ fullscreen: true });
    await flushWindowStateSync();

    expect(dragSurface.dataset.titlebarLayout).toBe("fullscreen");
    expect(controls.className).toContain("pl-3");
    expect(controls.className).not.toContain("pl-[82px]");

    electronWindowMocks.isFullscreen.mockResolvedValue(false);
    electronWindowMocks.emitWindowStateChanged({ fullscreen: false });
    await flushWindowStateSync();

    expect(dragSurface.dataset.titlebarLayout).toBe("windowed");
    expect(controls.className).toContain("pl-[82px]");
  });
});
