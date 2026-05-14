import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILinkProvider } from "@xterm/xterm";
import type { TerminalTabHandle } from "./TerminalTab";

let terminalDataHandler: ((data: string) => void) | null = null;
let terminalKeyHandler: ((event: { key: string; domEvent: KeyboardEvent }) => void) | null = null;
let terminalTitleHandler: ((title: string) => void) | null = null;
let registeredLinkProvider: ILinkProvider | null = null;
let mockTextarea: HTMLTextAreaElement;

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
  dispose: vi.fn(),
  focus: vi.fn(),
  clear: vi.fn(),
  scrollToBottom: vi.fn(),
  registerLinkProvider: vi.fn((provider: ILinkProvider) => {
    registeredLinkProvider = provider;
    return { dispose: vi.fn() };
  }),
  textarea: null as HTMLTextAreaElement | null,
  buffer: {
    active: {
      cursorX: 0,
      cursorY: 0,
      viewportY: 0,
      getLine: vi.fn(() => null),
    },
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
  registeredLinkProvider = null;
  MockWebSocket.instances = [];
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

  it("creates terminal once and loads expected addons", () => {
    act(() => {
      root.render(<TerminalTab sessionId="test-session" cwd="/tmp" />);
    });

    expect(mockTerminal.open).toHaveBeenCalledTimes(1);
    expect(mockTerminal.loadAddon).toHaveBeenCalledTimes(3);
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
      await new Promise((resolve) => setTimeout(resolve, 0));
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
