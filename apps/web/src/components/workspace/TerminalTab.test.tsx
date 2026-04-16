import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTabHandle } from "./TerminalTab";

let terminalDataHandler: ((data: string) => void) | null = null;
let mockTextarea: HTMLTextAreaElement;

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn((handler: (data: string) => void) => {
    terminalDataHandler = handler;
    return { dispose: vi.fn() };
  }),
  write: vi.fn(),
  dispose: vi.fn(),
  focus: vi.fn(),
  textarea: null as HTMLTextAreaElement | null,
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

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(new Event("open")), 10);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("ResizeObserver", vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
})));

import { TerminalTab } from "./TerminalTab";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockTextarea = document.createElement("textarea");
  mockTerminal.textarea = mockTextarea;
  terminalDataHandler = null;
  MockWebSocket.instances = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TerminalTab", () => {
  it("renders terminal container and connection status", () => {
    act(() => {
      root.render(<TerminalTab sessionId="test-session" cwd="/tmp" />);
    });
    expect(container.textContent).toContain("Connecting");
  });

  it("creates terminal and opens it in the container", () => {
    act(() => {
      root.render(<TerminalTab sessionId="test-session" cwd="/tmp" />);
    });
    expect(mockTerminal.open).toHaveBeenCalled();
    expect(mockTerminal.loadAddon).toHaveBeenCalledTimes(2);
  });

  it("shows connected status after WebSocket opens", async () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd={null} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.textContent).toContain("Connected");
  });

  it("registers onData handler for terminal input", () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });
    expect(mockTerminal.onData).toHaveBeenCalled();
  });

  it("disposes terminal on unmount", () => {
    act(() => {
      root.render(<TerminalTab sessionId="s1" cwd="/tmp" />);
    });
    act(() => root.unmount());
    expect(mockTerminal.dispose).toHaveBeenCalled();
    root = createRoot(container);
  });

  it("exposes imperative sendInput and focus methods", () => {
    const ref = createRef<TerminalTabHandle>();

    act(() => {
      root.render(<TerminalTab ref={ref} sessionId="s1" cwd="/tmp" />);
    });

    act(() => {
      ref.current?.sendInput("ls");
      ref.current?.focus();
    });

    expect(MockWebSocket.instances[0]?.send).toHaveBeenCalledWith("ls");
    expect(mockTerminal.focus).toHaveBeenCalled();
  });

  it("transforms typed input before sending when requested", () => {
    act(() => {
      root.render(
        <TerminalTab
          sessionId="s1"
          cwd="/tmp"
          transformInput={(data) => data === "a" ? "\u0001" : data}
        />,
      );
    });

    act(() => {
      terminalDataHandler?.("a");
    });

    expect(MockWebSocket.instances[0]?.send).toHaveBeenCalledWith("\u0001");
  });

  it("intercepts beforeinput text and sends transformed control data", () => {
    act(() => {
      root.render(
        <TerminalTab
          sessionId="s1"
          cwd="/tmp"
          transformInput={(data) => data === "c" ? "\u0003" : data}
        />,
      );
    });

    const beforeInputEvent = new Event("beforeinput", { bubbles: true, cancelable: true });
    Object.defineProperty(beforeInputEvent, "data", { value: "c" });

    act(() => {
      mockTextarea.dispatchEvent(beforeInputEvent);
    });

    expect(beforeInputEvent.defaultPrevented).toBe(true);
    expect(MockWebSocket.instances[0]?.send).toHaveBeenCalledWith("\u0003");
  });
});
