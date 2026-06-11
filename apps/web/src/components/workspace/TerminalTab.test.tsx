import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILinkProvider } from "@xterm/xterm";
import type { TerminalTabHandle } from "./TerminalTab";

let terminalDataHandler: ((data: string) => void) | null = null;
let terminalKeyHandler: ((event: { key: string; domEvent: KeyboardEvent }) => void) | null = null;
let terminalTitleHandler: ((title: string) => void) | null = null;
let terminalBufferChangeHandler: ((buffer: { type: "normal" | "alternate" }) => void) | null = null;
let registeredLinkProvider: ILinkProvider | null = null;
let webglContextLossHandler: (() => void) | null = null;
let mockTextarea: HTMLTextAreaElement;

function act<T>(callback: () => T): T {
  let result: T;
  flushSync(() => {
    result = callback();
  });
  return result!;
}

// Opens the stream gate by delivering the server's attach snapshot frame, the
// way the runtime does before any live output. Use in tests that inject raw
// PTY output directly.
function deliverAttachFrame(
  socketIndex = 0,
  overrides: Record<string, unknown> = {},
): void {
  act(() => {
    MockWebSocket.instances[socketIndex]?.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({
        kind: "cs-terminal-event",
        type: "attach",
        snapshotAnsi: "",
        rehydrateSequences: "",
        modes: { alternateScreen: false },
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        ...overrides,
      }),
    }));
  });
}

const { writeTerminalDropFiles } = vi.hoisted(() => ({
  writeTerminalDropFiles: vi.fn(),
}));

const mockSearchAddon = {
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => true),
  clearDecorations: vi.fn(),
};

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn((handler: (data: string) => void) => {
    terminalDataHandler = handler;
    return { dispose: vi.fn() };
  }),
  onTitleChange: vi.fn((handler: (title: string) => void) => {
    terminalTitleHandler = handler;
    return { dispose: vi.fn() };
  }),
  onKey: vi.fn((handler: (event: { key: string; domEvent: KeyboardEvent }) => void) => {
    terminalKeyHandler = handler;
    return { dispose: vi.fn() };
  }),
  paste: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
  dispose: vi.fn(),
  focus: vi.fn(),
  clear: vi.fn(),
  reset: vi.fn(),
  scrollToBottom: vi.fn(),
  rows: 24,
  registerLinkProvider: vi.fn((provider: ILinkProvider) => {
    registeredLinkProvider = provider;
    return { dispose: vi.fn() };
  }),
  parser: {
    registerCsiHandler: vi.fn((_selector: { intermediates?: string; final: string }) => ({ dispose: vi.fn() })),
  },
  textarea: null as HTMLTextAreaElement | null,
  buffer: {
    active: {
      cursorX: 0,
      cursorY: 0,
      viewportY: 0,
      getLine: vi.fn(() => null),
    },
    onBufferChange: vi.fn((handler: (buffer: { type: "normal" | "alternate" }) => void) => {
      terminalBufferChangeHandler = handler;
      return { dispose: vi.fn() };
    }),
  },
  unicode: {
    activeVersion: "11",
  },
};

const mockFitAddon = {
  fit: vi.fn(),
  proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => mockTerminal),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => mockFitAddon),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => mockSearchAddon),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(),
}));

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: vi.fn(),
}));

vi.mock("@xterm/addon-image", () => ({
  ImageAddon: vi.fn(),
}));

vi.mock("@xterm/addon-progress", () => ({
  ProgressAddon: vi.fn(),
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: vi.fn(),
}));

vi.mock("@xterm/addon-ligatures", () => ({
  LigaturesAddon: vi.fn(),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    onContextLoss: vi.fn((handler: () => void) => {
      webglContextLossHandler = handler;
    }),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("../../lib/api", () => ({
  api: {
    writeTerminalDropFiles,
  },
}));

vi.mock("../../lib/openExternalUrl", () => ({
  isTauriDesktop: vi.fn(() => false),
}));

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor() {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    }, 10);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("ResizeObserver", vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
})));
vi.stubGlobal("FileReader", class MockFileReader {
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
  onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

  readAsDataURL(file: Blob) {
    const mimeType = file instanceof File && file.type ? file.type : "application/octet-stream";
    this.result = `data:${mimeType};base64,dGVzdA==`;
    queueMicrotask(() => {
      this.onload?.call(this as never, new Event("load") as ProgressEvent<FileReader>);
    });
  }
});

import { TerminalTab } from "./TerminalTab";
import {
  collectTerminalFileLinks,
  resetTerminalRuntimeRegistryForTests,
} from "./terminalRuntimeRegistry";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetTerminalRuntimeRegistryForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockTextarea = document.createElement("textarea");
  mockTerminal.textarea = mockTextarea;
  terminalDataHandler = null;
  terminalKeyHandler = null;
  terminalTitleHandler = null;
  terminalBufferChangeHandler = null;
  registeredLinkProvider = null;
  webglContextLossHandler = null;
  MockWebSocket.instances = [];
  window.__CS_DEBUG_LOG__ = [];
  writeTerminalDropFiles.mockReset();
  mockTerminal.buffer.active.getLine.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  resetTerminalRuntimeRegistryForTests();
  container.remove();
});

describe("TerminalTab", () => {
  it("renders terminal container and a connecting status indicator", () => {
    act(() => {
      root.render(<TerminalTab sessionId="test-session" cwd="/tmp" />);
    });

    const indicator = container.querySelector('[data-testid="terminal-connection-indicator"]');
    expect(indicator?.getAttribute("aria-label")).toBe("Connecting");
  });

  it("keeps a mobile terminal keyboard toolbar above the soft keyboard", async () => {
    act(() => {
      root.render(
        <TerminalTab
          sessionId="s1"
          cwd="/tmp"
          showMobileKeyboardToolbar
          mobileBottomOffset={1}
        />,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const rootElement = container.querySelector<HTMLElement>('[data-testid="terminal-tab-root"]');
    const toolbar = container.querySelector<HTMLElement>('[data-testid="terminal-mobile-keyboard-toolbar"]');
    expect(toolbar).toBeTruthy();
    expect(toolbar?.style.bottom).toBe("var(--cs-mobile-keyboard-offset, 0px)");
    expect(rootElement?.style.paddingBottom).toContain("var(--cs-mobile-keyboard-offset, 0px)");

    const escapeButton = Array.from(toolbar?.querySelectorAll("button") ?? [])
      .find((button) => button.title === "Escape");
    if (!escapeButton) {
      throw new Error("Escape button not found");
    }

    act(() => {
      escapeButton.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    });

    expect(MockWebSocket.instances[0]?.send).toHaveBeenCalledWith("\u001b");
    expect(mockTerminal.focus).toHaveBeenCalled();
  });

  it("creates terminal once and loads expected addons", () => {
    act(() => {
      root.render(<TerminalTab sessionId="test-session" cwd="/tmp" />);
    });

    expect(mockTerminal.open).toHaveBeenCalledTimes(1);
    // 3 core addons (fit, search, web-links) + 5 synchronous optional addons
    // (clipboard, unicode11, image, progress, ligatures). WebGL loads in a
    // deferred animation frame, so it is not counted here.
    expect(mockTerminal.loadAddon).toHaveBeenCalledTimes(8);
  });

  it("opens a new runtime directly in the visible container instead of the parking container", () => {
    act(() => {
      root.render(<TerminalTab sessionId="test-session" cwd="/tmp" />);
    });

    const wrapper = mockTerminal.open.mock.calls[0]?.[0];
    expect(wrapper).toBeTruthy();
    expect((wrapper as HTMLElement).parentElement).not.toBeNull();
    expect((wrapper as HTMLElement).parentElement?.id).not.toBe("cs-terminal-runtime-parking");
    expect(document.getElementById("cs-terminal-runtime-parking")).toBeNull();
  });

  it("shows connected status after WebSocket opens", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd={null} />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const indicator = container.querySelector('[data-testid="terminal-connection-indicator"]');
    expect(indicator?.getAttribute("aria-label")).toBe("Connected");
  });

  it("reconnects interactive terminal sessions after an exit event", async () => {
    vi.useFakeTimers();

    act(() => {
      root.render(<TerminalTab sessionId="wt1:terminal:abc" cwd="/tmp" />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    const firstSocket = MockWebSocket.instances[0];
    expect(firstSocket).toBeTruthy();

    act(() => {
      firstSocket?.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          kind: "cs-terminal-event",
          type: "exit",
          exitCode: 0,
          signal: 0,
        }),
      }));
    });

    expect(firstSocket?.close).toHaveBeenCalledTimes(1);

    act(() => {
      firstSocket?.onclose?.(new CloseEvent("close", {
        code: 1000,
        reason: "Terminal exited",
      }));
    });

    const reconnectingIndicator = container.querySelector('[data-testid="terminal-connection-indicator"]');
    expect(reconnectingIndicator?.getAttribute("aria-label")).toBe("Reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2010);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    const connectedIndicator = container.querySelector('[data-testid="terminal-connection-indicator"]');
    expect(connectedIndicator?.getAttribute("aria-label")).toBe("Connected");
  });

  it("nudges the terminal size after reconnect so fullscreen TUIs repaint on restore", async () => {
    vi.useFakeTimers();
    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 720,
    });

    try {
      act(() => {
        root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      const sentMessagesAfterOpen = MockWebSocket.instances[0]?.send.mock.calls.map(([message]) => message);
      expect(sentMessagesAfterOpen).toEqual([
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(MockWebSocket.instances[0]?.send.mock.calls.map(([message]) => message)).toEqual([
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      ]);
    } finally {
      if (clientWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      }
    }
  });

  it("recovers fullscreen TUIs when the WebGL renderer context is lost", async () => {
    vi.useFakeTimers();
    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 720,
    });

    try {
      act(() => {
        root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
      });

      // Flush the deferred animation frame that loads the WebGL addon so its
      // context-loss handler is registered, plus the open-time fit/redraw
      // nudges so they do not bleed into the loss assertions below.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(webglContextLossHandler).toBeTruthy();

      const sendsBeforeLoss = MockWebSocket.instances[0]?.send.mock.calls.length ?? 0;
      mockTerminal.refresh.mockClear();

      // Simulate the GPU dropping the terminal's WebGL context. The terminal
      // canvas goes blank until the DOM renderer repaints, which only happens
      // for fullscreen TUIs (alt-screen) after a resize nudge.
      act(() => {
        webglContextLossHandler?.();
      });

      // Immediate repaint attempt with the DOM renderer.
      expect(mockTerminal.refresh).toHaveBeenCalledWith(0, 23);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      const sendsAfterLoss = MockWebSocket.instances[0]?.send.mock.calls
        .slice(sendsBeforeLoss)
        .map(([message]) => message);

      // A resize nudge (shrink then restore) forces the alt-screen TUI to
      // redraw into the freshly-active DOM renderer. The reconnect nudge runs
      // twice (at 120ms and 360ms), so the shrink/restore pair appears twice.
      expect(sendsAfterLoss).toEqual([
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      ]);
    } finally {
      if (clientWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      }
    }
  });

  it("shows a header title and updates it from terminal title events", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp/my-repo" />);
    });

    expect(container.textContent).toContain("my-repo");

    act(() => {
      terminalTitleHandler?.("Claude Code");
    });

    expect(container.textContent).toContain("Claude Code");
  });

  it("renders a braille title prefix with the primary accent color", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp/my-repo" />);
    });

    act(() => {
      terminalTitleHandler?.("⠧ ChordPro");
    });

    const braillePrefix = container.querySelector('[data-testid="terminal-title-braille-prefix"]');
    expect(braillePrefix?.textContent).toBe("⠧");
    expect(braillePrefix?.className).toContain("text-primary");
    expect(container.textContent).toContain("ChordPro");
  });

  it("uses the echoed command as a fallback terminal title", async () => {
    mockTerminal.buffer.active.cursorX = 19;
    mockTerminal.buffer.active.cursorY = 0;
    mockTerminal.buffer.active.viewportY = 0;
    mockTerminal.buffer.active.getLine.mockReturnValue({
      isWrapped: false,
      translateToString: () => "user@host$ claude",
    } as never);

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp/my-repo" />);
    });

    act(() => {
      terminalKeyHandler?.({ key: "c", domEvent: new KeyboardEvent("keydown", { key: "c" }) });
      terminalKeyHandler?.({ key: "l", domEvent: new KeyboardEvent("keydown", { key: "l" }) });
      terminalKeyHandler?.({ key: "a", domEvent: new KeyboardEvent("keydown", { key: "a" }) });
      terminalKeyHandler?.({ key: "u", domEvent: new KeyboardEvent("keydown", { key: "u" }) });
      terminalKeyHandler?.({ key: "d", domEvent: new KeyboardEvent("keydown", { key: "d" }) });
      terminalKeyHandler?.({ key: "e", domEvent: new KeyboardEvent("keydown", { key: "e" }) });
      terminalKeyHandler?.({ key: "Enter", domEvent: new KeyboardEvent("keydown", { key: "Enter" }) });
    });

    expect(container.textContent).toContain("claude");
  });

  it("keeps the runtime alive across unmounts and reuses it on remount", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    act(() => root.unmount());
    expect(mockTerminal.dispose).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(1);

    root = createRoot(container);
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    expect(mockTerminal.open).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("exposes imperative sendInput and focus methods", async () => {
    const ref = createRef<TerminalTabHandle>();

    act(() => {
      root.render(<TerminalTab ref={ref} sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    act(() => {
      ref.current?.sendInput("ls");
      ref.current?.focus();
    });

    expect(MockWebSocket.instances[0]?.send).toHaveBeenCalledWith("ls");
    expect(mockTerminal.focus).toHaveBeenCalled();
  });

  it("repaints when a full-screen TUI switches to the alternate screen buffer", async () => {
    // Regression: opencode/vim entry was previously detected by regex-matching
    // raw WebSocket chunks for \x1b[?1049h. Frame splitting made that miss and
    // the TUI stayed blank until a manual resize. Detection now rides xterm's
    // onBufferChange, so an alternate-buffer switch must force a repaint.
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    mockTerminal.refresh.mockClear();

    act(() => {
      terminalBufferChangeHandler?.({ type: "alternate" });
    });

    expect(mockTerminal.refresh).toHaveBeenCalled();
  });

  it("does not repaint when the buffer switches back to normal", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    mockTerminal.refresh.mockClear();

    act(() => {
      terminalBufferChangeHandler?.({ type: "normal" });
    });

    expect(mockTerminal.refresh).not.toHaveBeenCalled();
  });

  it("transforms typed input before sending when requested", async () => {
    act(() => {
      root.render(
        <TerminalTab
          sessionId="s1"
          cwd="/tmp"
          transformInput={(data) => data === "a" ? "\u0001" : data}
        />,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    act(() => {
      terminalDataHandler?.("a");
    });

    expect(MockWebSocket.instances[0]?.send).toHaveBeenCalledWith("\u0001");
  });

  it("logs sanitized typing diagnostics when xterm data is sent", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    window.__CS_DEBUG_LOG__ = [];

    act(() => {
      terminalDataHandler?.("secret-token");
    });

    const inputLog = window.__CS_DEBUG_LOG__?.find(
      (entry) => entry.source === "terminal.typing" && entry.message === "[DEBUG-terminal-typing] client.onData.send",
    );
    expect(inputLog?.data).toMatchObject({
      sessionId: "s1",
      stage: "onData",
      rawSummary: {
        kind: "printable",
        byteLength: 12,
        printableAsciiCount: 12,
      },
      nextSummary: {
        kind: "printable",
        byteLength: 12,
      },
      socketReadyState: 1,
      sendAttempted: true,
      sent: true,
    });
    expect(inputLog?.data).toHaveProperty("inputSeq", expect.any(Number));
    expect(JSON.stringify(inputLog?.data)).not.toContain("secret-token");
  });

  it("logs sanitized keydown diagnostics before xterm input conversion", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    window.__CS_DEBUG_LOG__ = [];

    act(() => {
      mockTextarea.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "x",
      }));
    });

    const keyLog = window.__CS_DEBUG_LOG__?.find(
      (entry) => entry.source === "terminal.typing" && entry.message === "[DEBUG-terminal-typing] client.keydown",
    );
    expect(keyLog?.data).toMatchObject({
      sessionId: "s1",
      stage: "keydown",
      keyboard: {
        keyKind: "character",
        keySummary: {
          kind: "printable",
          byteLength: 1,
        },
        keyName: null,
      },
    });
    expect(JSON.stringify(keyLog?.data)).not.toContain('"keyName":"x"');
  });

  it("intercepts beforeinput text and sends transformed control data", async () => {
    act(() => {
      root.render(
        <TerminalTab
          sessionId="s1"
          cwd="/tmp"
          transformInput={(data) => data === "c" ? "\u0003" : data}
        />,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const beforeInputEvent = new Event("beforeinput", { bubbles: true, cancelable: true });
    Object.defineProperty(beforeInputEvent, "data", { value: "c" });

    act(() => {
      mockTextarea.dispatchEvent(beforeInputEvent);
    });

    expect(beforeInputEvent.defaultPrevented).toBe(true);
    expect(MockWebSocket.instances[0]?.send).toHaveBeenCalledWith("\u0003");
  });

  it("does not send the original xterm data after beforeinput sends transformed data", async () => {
    act(() => {
      root.render(
        <TerminalTab
          sessionId="s1"
          cwd="/tmp"
          transformInput={(data) => data === "c" ? "\u0003" : data}
        />,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const beforeInputEvent = new Event("beforeinput", { bubbles: true, cancelable: true });
    Object.defineProperty(beforeInputEvent, "data", { value: "c" });

    act(() => {
      mockTextarea.dispatchEvent(beforeInputEvent);
      terminalDataHandler?.("c");
    });

    const inputSends = MockWebSocket.instances[0]?.send.mock.calls
      .filter(([message]) => typeof message === "string" && !message.startsWith("{"));
    expect(inputSends).toEqual([["\u0003"]]);
    expect(MockWebSocket.instances[0]?.send.mock.calls).not.toContainEqual(["c"]);
  });

  it("drops malformed SGR mouse reports with NaN coordinates before they reach the PTY", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    act(() => {
      terminalDataHandler?.("\x1b[<0;NaN;NaNM");
    });

    expect(MockWebSocket.instances[0]?.send.mock.calls).not.toContainEqual(["\x1b[<0;NaN;NaNM"]);
  });

  it("sends only the latest Android beforeinput text when xterm reports cumulative textarea data", async () => {
    const userAgentDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
    Object.defineProperty(Navigator.prototype, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (Linux; Android 14)",
    });

    try {
      act(() => {
        root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const firstBeforeInput = new Event("beforeinput", { bubbles: true, cancelable: true });
      Object.defineProperty(firstBeforeInput, "data", { value: "a" });
      const secondBeforeInput = new Event("beforeinput", { bubbles: true, cancelable: true });
      Object.defineProperty(secondBeforeInput, "data", { value: "b" });

      act(() => {
        mockTextarea.dispatchEvent(firstBeforeInput);
        terminalDataHandler?.("a");
        mockTextarea.dispatchEvent(secondBeforeInput);
        terminalDataHandler?.("ab");
      });

      const inputSends = MockWebSocket.instances[0]?.send.mock.calls
        .filter(([message]) => typeof message === "string" && !message.startsWith("{"));
      expect(inputSends).toEqual([["a"], ["b"]]);
    } finally {
      if (userAgentDescriptor) {
        Object.defineProperty(Navigator.prototype, "userAgent", userAgentDescriptor);
      }
    }
  });

  it("refreshes after fullscreen terminal chunks finish writing", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();
    mockTerminal.write.mockClear();
    mockTerminal.refresh.mockClear();

    const fullscreenChunk = "\x1b[?1049h\x1b[?2026hOpenCode\x1b[?2026l";
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
        data: fullscreenChunk,
      }));
    });

    const writeCallback = mockTerminal.write.mock.calls.at(-1)?.[1];
    expect(mockTerminal.write).toHaveBeenLastCalledWith(fullscreenChunk, expect.any(Function));
    expect(mockTerminal.refresh).not.toHaveBeenCalled();

    act(() => {
      if (typeof writeCallback === "function") {
        writeCallback();
      }
    });

    expect(mockTerminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("logs sanitized terminal output received from the websocket", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();
    window.__CS_DEBUG_LOG__ = [];

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
        data: "secret output\n",
      }));
    });

    const outputLog = window.__CS_DEBUG_LOG__?.find(
      (entry) => entry.source === "terminal.output" && entry.message === "[DEBUG-terminal-typing] client.ws.output",
    );
    expect(outputLog?.data).toMatchObject({
      sessionId: "s1",
      outputSummary: {
        kind: "paste",
        byteLength: 14,
        lineBreakCount: 1,
      },
    });
    expect(JSON.stringify(outputLog?.data)).not.toContain("secret output");
  });

  it("nudges replayed alternate-screen chunks even when the buffer is already alternate", async () => {
    vi.useFakeTimers();
    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 720,
    });

    try {
      act(() => {
        root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      deliverAttachFrame();

      MockWebSocket.instances[0]?.send.mockClear();
      mockTerminal.refresh.mockClear();
      mockTerminal.scrollToBottom.mockClear();
      mockTerminal.write.mockClear();

      const replayChunk = "\x1b[?1049hOpenCode";
      act(() => {
        MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
          data: replayChunk,
        }));
      });

      const writeCallback = mockTerminal.write.mock.calls.at(-1)?.[1];
      expect(mockTerminal.write).toHaveBeenLastCalledWith(replayChunk, expect.any(Function));

      act(() => {
        if (typeof writeCallback === "function") {
          writeCallback();
        }
      });

      expect(mockTerminal.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(mockTerminal.refresh).toHaveBeenCalledWith(0, 23);

      mockTerminal.write.mockClear();
      mockTerminal.refresh.mockClear();
      mockTerminal.scrollToBottom.mockClear();

      act(() => {
        MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
          data: "next tui frame",
        }));
      });

      const nextWriteCallback = mockTerminal.write.mock.calls.at(-1)?.[1];
      expect(mockTerminal.write).toHaveBeenLastCalledWith("next tui frame", expect.any(Function));

      act(() => {
        if (typeof nextWriteCallback === "function") {
          nextWriteCallback();
        }
      });

      expect(mockTerminal.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(mockTerminal.refresh).toHaveBeenCalledWith(0, 23);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(MockWebSocket.instances[0]?.send.mock.calls.map(([message]) => message)).toEqual([
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      ]);
    } finally {
      if (clientWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      }
    }
  });

  it("registers query-response suppression handlers on the terminal parser", async () => {
    vi.useFakeTimers();

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    const finals = mockTerminal.parser.registerCsiHandler.mock.calls.map(
      (call) => call[0],
    );
    expect(finals).toContainEqual({ final: "R" });
    expect(finals).toContainEqual({ final: "I" });
    expect(finals).toContainEqual({ final: "O" });
    expect(finals).toContainEqual({ intermediates: "$", final: "y" });
  });

  it("restores an alternate-screen TUI deterministically from the attach snapshot", async () => {
    vi.useFakeTimers();

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    mockTerminal.write.mockClear();

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          kind: "cs-terminal-event",
          type: "attach",
          // The serialized alt-screen snapshot already carries the alt-enter
          // sequence plus the painted screen contents.
          snapshotAnsi: "\x1b[?1049h\x1b[HOpenCode screen contents",
          rehydrateSequences: "\x1b[?2004h",
          modes: { alternateScreen: true },
          cwd: "/tmp",
          cols: 80,
          rows: 24,
        }),
      }));
    });

    // Drive any write callbacks so the chained writes run to completion.
    for (let i = 0; i < mockTerminal.write.mock.calls.length; i += 1) {
      const callback = mockTerminal.write.mock.calls[i]?.[1];
      if (typeof callback === "function") {
        act(() => {
          callback();
        });
      }
    }

    const writes = mockTerminal.write.mock.calls.map((call) => call[0]);
    // The snapshot body MUST be written so the alt screen actually paints —
    // otherwise the pane stays blank until a manual refresh.
    expect(writes).toContain("\x1b[?1049h\x1b[HOpenCode screen contents");
    // Input-mode rehydrate is applied too.
    expect(writes).toContain("\x1b[?2004h");
  });

  it("queues live output until the attach snapshot is applied then flushes it", async () => {
    vi.useFakeTimers();

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    mockTerminal.write.mockClear();

    // Live data arrives before the attach frame — must be held, not written.
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
        data: "live-before-attach",
      }));
    });
    expect(mockTerminal.write).not.toHaveBeenCalledWith("live-before-attach");

    // A normal-buffer attach frame restores, then flushes the queued data.
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
        data: JSON.stringify({
          kind: "cs-terminal-event",
          type: "attach",
          snapshotAnsi: "",
          rehydrateSequences: "",
          modes: { alternateScreen: false },
          cwd: "/tmp",
          cols: 80,
          rows: 24,
        }),
      }));
    });

    const flushedWrites = mockTerminal.write.mock.calls.map(([data]) => data);
    expect(flushedWrites).toContain("live-before-attach");
  });

  it("renders live output even if the attach snapshot never arrives (no permanent gate)", async () => {
    vi.useFakeTimers();

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    mockTerminal.write.mockClear();

    // Live output arrives, but the server never sends an attach frame (e.g. the
    // first resize never fired, so the deferred snapshot was never requested).
    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
        data: "\x1b[?1049hopencode TUI paint",
      }));
    });

    // The gate must open on its own after the fallback timeout so the terminal
    // never stays blank forever waiting on an attach frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const writes = mockTerminal.write.mock.calls.map((call) => call[0]);
    expect(writes).toContain("\x1b[?1049hopencode TUI paint");
  });

  it("nudges live alternate-screen entry split across websocket frames", async () => {
    vi.useFakeTimers();
    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1200,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 720,
    });

    try {
      act(() => {
        root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      deliverAttachFrame();

      MockWebSocket.instances[0]?.send.mockClear();
      mockTerminal.refresh.mockClear();
      mockTerminal.scrollToBottom.mockClear();
      mockTerminal.write.mockClear();

      act(() => {
        MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
          data: "\x1b[?10",
        }));
        MockWebSocket.instances[0]?.onmessage?.(new MessageEvent("message", {
          data: "49hOpenCode",
        }));
      });

      const writeCallback = mockTerminal.write.mock.calls.at(-1)?.[1];
      expect(mockTerminal.write).toHaveBeenLastCalledWith("49hOpenCode", expect.any(Function));

      act(() => {
        if (typeof writeCallback === "function") {
          writeCallback();
        }
      });

      expect(mockTerminal.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(mockTerminal.refresh).toHaveBeenCalledWith(0, 23);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(MockWebSocket.instances[0]?.send.mock.calls.map(([message]) => message)).toEqual([
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 79, rows: 24 }),
        JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
      ]);
    } finally {
      if (clientWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      }
    }
  });

  it("does not reconnect when only onSessionExit changes and still uses the latest callback", async () => {
    const firstExitHandler = vi.fn();
    const secondExitHandler = vi.fn();

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" onSessionExit={firstExitHandler} />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" onSessionExit={secondExitHandler} />);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(mockTerminal.dispose).not.toHaveBeenCalled();

    act(() => {
      MockWebSocket.instances[0]?.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            kind: "cs-terminal-event",
            type: "exit",
            exitCode: 0,
            signal: 0,
          }),
        }),
      );
    });

    expect(firstExitHandler).not.toHaveBeenCalled();
    expect(secondExitHandler).toHaveBeenCalledWith({ exitCode: 0, signal: 0 });
  });

  it("uploads dropped browser files and pastes runtime paths into the terminal", async () => {
    writeTerminalDropFiles.mockResolvedValue([{
      path: "/tmp/my image.png",
      filename: "my image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    }]);

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        types: ["Files"],
        items: [
          {
            kind: "file",
            getAsFile: () => new File(["test"], "my image.png", { type: "image/png" }),
          },
        ],
        files: [new File(["test"], "my image.png", { type: "image/png" })],
        getData: () => "",
      },
    });

    await act(async () => {
      container.firstElementChild?.dispatchEvent(dropEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(writeTerminalDropFiles).toHaveBeenCalledWith("s1", [{
      filename: "my image.png",
      mimeType: "image/png",
      contentBase64: "dGVzdA==",
    }]);
    expect(mockTerminal.paste).toHaveBeenCalledWith("'/tmp/my image.png'");
  });

  it("pastes plain-text drops directly into the terminal", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        types: ["text/plain"],
        items: [],
        files: [],
        getData: (type: string) => type === "text/plain" ? "/tmp/demo folder/file.txt" : "",
      },
    });

    act(() => {
      container.firstElementChild?.dispatchEvent(dropEvent);
    });

    expect(mockTerminal.paste).toHaveBeenCalledWith("'/tmp/demo folder/file.txt'");
    expect(writeTerminalDropFiles).not.toHaveBeenCalled();
  });

  it("renders the header search button and opens the search overlay from the terminal find shortcut", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector('button[aria-label="Search terminal output"]')).toBeTruthy();

    act(() => {
      container.firstElementChild?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "f",
      }));
    });

    const searchInput = container.querySelector('input[placeholder="Find"]');
    expect(searchInput).toBeTruthy();
  });

  it("uses enter shortcuts and case toggle in the terminal search overlay", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    act(() => {
      container.firstElementChild?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "f",
      }));
    });

    const searchInput = container.querySelector('input[placeholder="Find"]');
    const matchCaseButton = container.querySelector('button[aria-label="Match case"]');
    expect(searchInput).toBeTruthy();
    expect(matchCaseButton).toBeTruthy();

    act(() => {
      if (searchInput instanceof HTMLInputElement) {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setValue?.call(searchInput, "build");
      }
      searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(mockSearchAddon.findNext).toHaveBeenCalledWith("build", expect.objectContaining({
      caseSensitive: false,
    }));

    act(() => {
      matchCaseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockSearchAddon.findNext).toHaveBeenLastCalledWith("build", expect.objectContaining({
      caseSensitive: true,
    }));

    act(() => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        shiftKey: true,
      }));
    });

    expect(mockSearchAddon.findPrevious).toHaveBeenCalledWith("build", expect.objectContaining({
      caseSensitive: true,
    }));

    act(() => {
      searchInput?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
    });

    expect(container.querySelector('input[placeholder="Find"]')).toBeNull();
    expect(mockSearchAddon.clearDecorations).toHaveBeenCalled();
  });

  it("provides clickable terminal file links that call onOpenFile", async () => {
    const onOpenFile = vi.fn();
    mockTerminal.buffer.active.getLine.mockReturnValue({
      translateToString: () => "Error in src/app.ts:12:3",
    } as never);

    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" onOpenFile={onOpenFile} />);
    });

    expect(registeredLinkProvider).toBeTruthy();

    const callback = vi.fn();
    registeredLinkProvider?.provideLinks(1, callback);
    const links = callback.mock.calls[0]?.[0] ?? [];

    expect(links).toHaveLength(1);

    act(() => {
      links[0].activate(new MouseEvent("click"), links[0].text);
    });

    expect(onOpenFile).toHaveBeenCalledWith("src/app.ts:12:3");
  });

  it("collects file-like terminal path references", () => {
    expect(collectTerminalFileLinks("See src/app.ts:12 and ../notes/README.md")).toEqual([
      {
        text: "src/app.ts:12",
        startIndex: 4,
        endIndex: 17,
      },
      {
        text: "../notes/README.md",
        startIndex: 22,
        endIndex: 40,
      },
    ]);
  });
});
