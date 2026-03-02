import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
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
  readyState = 1;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
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
});
