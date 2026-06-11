/**
 * Tests for IME composition input recovery in the terminal runtime.
 *
 * On macOS with IME (e.g. Indonesian or CJK input methods), xterm.js may clear
 * textarea.value before the compositionend handler reads it, causing composed
 * text (including spaces between words) to be lost. The fix tracks the last
 * known textarea value during composition and uses it as a fallback.
 */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTab } from "./TerminalTab";

let terminalDataHandler: ((data: string) => void) | null = null;
let terminalKeyHandler: ((event: { key: string; domEvent: KeyboardEvent }) => void) | null = null;
let terminalTitleHandler: ((title: string) => void) | null = null;
let terminalBufferChangeHandler: ((buffer: { type: "normal" | "alternate" }) => void) | null = null;
let mockTextarea: HTMLTextAreaElement;

function act<T>(callback: () => T): T {
  let result: T;
  flushSync(() => {
    result = callback();
  });
  return result!;
}

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
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
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
    onContextLoss: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("../../lib/api", () => ({
  api: {
    writeTerminalDropFiles: vi.fn(),
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
    }, 0);
  }
}

let originalWebSocket: typeof WebSocket;
let container: HTMLDivElement;
let root: Root;
let testCounter = 0;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;
  MockWebSocket.instances = [];
  terminalDataHandler = null;
  terminalKeyHandler = null;
  terminalTitleHandler = null;
  terminalBufferChangeHandler = null;

  mockTextarea = document.createElement("textarea");
  mockTerminal.textarea = mockTextarea;
  vi.clearAllMocks();

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  testCounter++;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket;
  MockWebSocket.instances = [];
  act(() => {
    root.unmount();
  });
  container.remove();
});

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

function sessionId(): string {
  return `s${testCounter}`;
}

/**
 * Simulates an IME composition cycle:
 * 1. compositionstart (textarea empty)
 * 2. keydown events while composing (textarea grows)
 * 3. compositionend (xterm clears textarea before handler reads it)
 */
function simulateCompositionSequence(text: string): void {
  act(() => {
    mockTextarea.value = "";
    mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
  });

  act(() => {
    mockTextarea.value = text;
    mockTextarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Unidentified",
      bubbles: true,
    }));
  });

  act(() => {
    mockTextarea.value = "";
    mockTextarea.dispatchEvent(new CompositionEvent("compositionend", { data: text }));
  });
}

describe("Terminal composition input recovery", () => {
  it("recovers space character when textarea is cleared before compositionend", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    simulateCompositionSequence(" ");

    expect(ws!.send).toHaveBeenCalledWith(" ");
  });

  it("recovers multi-character IME text when textarea is cleared before compositionend", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    simulateCompositionSequence("gitu");

    expect(ws!.send).toHaveBeenCalledWith("gitu");
  });

  it("still uses textarea.value directly when available at compositionend", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
    });

    act(() => {
      mockTextarea.value = "hello";
      mockTextarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Unidentified",
        bubbles: true,
      }));
    });

    act(() => {
      mockTextarea.dispatchEvent(new CompositionEvent("compositionend"));
    });

    expect(ws!.send).toHaveBeenCalledWith("hello");
  });

  it("uses compositionend event data when textarea was cleared before compositionend", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
    });

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionend", { data: "final" }));
    });

    expect(ws!.send).toHaveBeenCalledWith("final");
  });

  it("blocks xterm onData while IME composition is active", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();
    expect(terminalDataHandler).toBeTruthy();

    act(() => {
      mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
    });

    act(() => {
      terminalDataHandler!("g");
      terminalDataHandler!("i");
      terminalDataHandler!("t");
    });

    expect(ws!.send).not.toHaveBeenCalledWith("g");
    expect(ws!.send).not.toHaveBeenCalledWith("i");
    expect(ws!.send).not.toHaveBeenCalledWith("t");

    act(() => {
      mockTextarea.dispatchEvent(new CompositionEvent("compositionend", { data: "git" }));
    });

    expect(ws!.send).toHaveBeenCalledWith("git");
    expect(ws!.send).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate onData after compositionend send", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();
    expect(terminalDataHandler).toBeTruthy();

    simulateCompositionSequence("hello");

    expect(ws!.send).toHaveBeenCalledWith("hello");
    const callsAfterComposition = ws!.send.mock.calls.length;

    act(() => {
      terminalDataHandler!("hello");
    });

    expect(ws!.send.mock.calls.length).toBe(callsAfterComposition);
  });

  it("recovers full IME text when xterm clears textarea before compositionend", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
    });

    act(() => {
      mockTextarea.value = "ab";
      mockTextarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Unidentified",
        bubbles: true,
      }));
    });

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
    });

    expect(ws!.send).toHaveBeenCalledWith("ab");
  });

  it("sends shortened IME text after backspacing during composition", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
    });

    act(() => {
      mockTextarea.value = "abcd";
      mockTextarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Unidentified",
        bubbles: true,
      }));
      mockTextarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "abcd" }));
    });

    act(() => {
      mockTextarea.value = "ab";
      mockTextarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Unidentified",
        bubbles: true,
      }));
      mockTextarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ab" }));
    });

    act(() => {
      mockTextarea.value = "a";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
    });

    expect(ws!.send).toHaveBeenCalledWith("a");
  });

  it("prefers textarea over stale compositionend event data when textarea is longer", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
    });

    act(() => {
      mockTextarea.value = "abcdef";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionend", { data: "abcde" }));
    });

    expect(ws!.send).toHaveBeenCalledWith("abcdef");
  });

  it("does not send empty composition when no text was composed", async () => {
    act(() => {
      root.render(<TerminalTab sessionId={sessionId()} cwd="/tmp" />);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    deliverAttachFrame();

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();
    const sendCallsBefore = ws!.send.mock.calls.length;

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionstart"));
    });

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Unidentified",
        bubbles: true,
      }));
    });

    act(() => {
      mockTextarea.value = "";
      mockTextarea.dispatchEvent(new CompositionEvent("compositionend"));
    });

    expect(ws!.send.mock.calls.length).toBe(sendCallsBefore);
  });
});
