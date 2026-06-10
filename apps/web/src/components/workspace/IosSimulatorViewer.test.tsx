import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IosSimulatorViewer } from "./IosSimulatorViewer";

const {
  getMobileDeviceViewerControlsFlagMock,
  readIosSimulatorClipboardMock,
  supportsIosNativeViewerMock,
} = vi.hoisted(() => ({
  getMobileDeviceViewerControlsFlagMock: vi.fn(),
  readIosSimulatorClipboardMock: vi.fn(),
  supportsIosNativeViewerMock: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    readIosSimulatorClipboard: readIosSimulatorClipboardMock,
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
  readIosSimulatorClipboardMock.mockResolvedValue("");
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

  it("copies the iOS simulator clipboard into the browser clipboard on mobile browsers", async () => {
    readIosSimulatorClipboardMock.mockResolvedValue("copied from ios simulator");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
      ?? Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      await act(async () => {
        renderViewer();
        await Promise.resolve();
      });

      const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy iOS simulator clipboard"]');
      expect(copyButton).not.toBeNull();

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(readIosSimulatorClipboardMock).toHaveBeenCalledWith("ios-stream-1");
      expect(writeText).toHaveBeenCalledWith("copied from ios simulator");
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("falls back to legacy browser copy when async clipboard write is denied", async () => {
    readIosSimulatorClipboardMock.mockResolvedValue("fallback ios clipboard");
    const writeText = vi.fn().mockRejectedValue(new DOMException("Write permission denied", "NotAllowedError"));
    const execCommand = vi.fn().mockReturnValue(true);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
      ?? Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    try {
      await act(async () => {
        renderViewer();
        await Promise.resolve();
      });

      const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy iOS simulator clipboard"]');
      expect(copyButton).not.toBeNull();

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith("fallback ios clipboard");
      expect(execCommand).toHaveBeenCalledWith("copy");
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (execCommandDescriptor) {
        Object.defineProperty(document, "execCommand", execCommandDescriptor);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });

  it("retries cached simulator clipboard text synchronously after a blocked browser copy", async () => {
    readIosSimulatorClipboardMock.mockResolvedValue("cached ios clipboard");
    const execCommand = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
      ?? Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    try {
      await act(async () => {
        renderViewer();
        await Promise.resolve();
      });

      const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy iOS simulator clipboard"]');
      expect(copyButton).not.toBeNull();

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(readIosSimulatorClipboardMock).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledTimes(1);

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(readIosSimulatorClipboardMock).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledTimes(2);
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (execCommandDescriptor) {
        Object.defineProperty(document, "execCommand", execCommandDescriptor);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }
  });
});
