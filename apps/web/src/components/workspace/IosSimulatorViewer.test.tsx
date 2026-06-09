import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IosSimulatorViewer } from "./IosSimulatorViewer";

const { getMobileDeviceViewerControlsFlagMock, supportsIosNativeViewerMock } = vi.hoisted(() => ({
  getMobileDeviceViewerControlsFlagMock: vi.fn(),
  supportsIosNativeViewerMock: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    runtimeBaseUrl: "http://127.0.0.1:4331",
  },
}));

vi.mock("../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

vi.mock("../../lib/deviceStreamMetrics", () => ({
  createDeviceStreamMetrics: () => ({
    flush: vi.fn(),
    markConnectStart: vi.fn(),
    markControl: vi.fn(),
    markFrame: vi.fn(),
    markMode: vi.fn(),
  }),
}));

vi.mock("./deviceViewerEnvironment", () => ({
  getMobileDeviceViewerControlsFlag: getMobileDeviceViewerControlsFlagMock,
  supportsIosNativeViewer: supportsIosNativeViewerMock,
}));

class MockResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  binaryType = "";
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close = vi.fn(() => {
    this.readyState = 3;
  });

  send = vi.fn((message: string) => {
    this.sent.push(message);
  });
}

let container: HTMLDivElement;
let root: Root;
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalWebSocket: typeof WebSocket | undefined;

function renderViewer() {
  root.render(<IosSimulatorViewer deviceName="iPhone 15 Pro" sessionId="ios-stream-1" />);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  MockWebSocket.instances = [];
  getMobileDeviceViewerControlsFlagMock.mockReturnValue(true);
  supportsIosNativeViewerMock.mockReturnValue(false);
  originalResizeObserver = globalThis.ResizeObserver;
  originalWebSocket = globalThis.WebSocket;
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
  globalThis.WebSocket = originalWebSocket as typeof WebSocket;
});

describe("IosSimulatorViewer", () => {
  it("shows simulator keyboard control next to Shake in mobile controls mode without host keyboard bridge", async () => {
    await act(async () => {
      renderViewer();
      await Promise.resolve();
    });

    expect(container.querySelector('textarea[aria-label="iOS keyboard bridge"]')).toBeNull();

    const shakeButton = container.querySelector<HTMLButtonElement>('button[aria-label="iOS Shake"]');
    expect(shakeButton).not.toBeNull();
    expect(shakeButton?.nextElementSibling?.getAttribute("aria-label")).toBe("Show iOS simulator keyboard");
  });

  it("only requests the simulator software keyboard on mobile", async () => {
    await act(async () => {
      renderViewer();
      await Promise.resolve();
    });

    const keyboardButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show iOS simulator keyboard"]');
    expect(keyboardButton).not.toBeNull();

    act(() => {
      keyboardButton?.focus();
      keyboardButton?.click();
    });

    expect(document.activeElement).not.toBe(keyboardButton);
    expect(document.activeElement).not.toBe(container.querySelector('textarea[aria-label="iOS keyboard bridge"]'));
    expect(MockWebSocket.instances[0]?.sent.map((message) => JSON.parse(message))).toContainEqual({
      name: "show_keyboard",
      t: "system",
    });

    const showKeyboardButtonAgain = container.querySelector<HTMLButtonElement>('button[aria-label="Show iOS simulator keyboard"]');
    expect(showKeyboardButtonAgain).not.toBeNull();

    act(() => {
      showKeyboardButtonAgain?.click();
    });

    expect(document.activeElement).not.toBe(container.querySelector('textarea[aria-label="iOS keyboard bridge"]'));
    expect(MockWebSocket.instances[0]?.sent.map((message) => JSON.parse(message))).not.toContainEqual(
      expect.objectContaining({ name: "hide_keyboard" }),
    );
  });
});
