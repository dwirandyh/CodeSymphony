import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AndroidDeviceViewer } from "./AndroidDeviceViewer";

const { getMobileDeviceViewerControlsFlagMock, supportsAndroidNativeViewerMock } = vi.hoisted(() => ({
  getMobileDeviceViewerControlsFlagMock: vi.fn(),
  supportsAndroidNativeViewerMock: vi.fn(),
}));
const {
  readAndroidClipboardMock,
  readHostClipboardMock,
  sendDeviceControlMock,
  writeAndroidClipboardMock,
  writeHostClipboardMock,
} = vi.hoisted(() => ({
  readAndroidClipboardMock: vi.fn(),
  readHostClipboardMock: vi.fn(),
  sendDeviceControlMock: vi.fn(),
  writeAndroidClipboardMock: vi.fn(),
  writeHostClipboardMock: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    readAndroidClipboard: readAndroidClipboardMock,
    readHostClipboard: readHostClipboardMock,
    runtimeBaseUrl: "http://127.0.0.1:4331",
    sendDeviceControl: sendDeviceControlMock,
    writeAndroidClipboard: writeAndroidClipboardMock,
    writeHostClipboard: writeHostClipboardMock,
  },
}));

vi.mock("../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

vi.mock("./deviceViewerEnvironment", () => ({
  getMobileDeviceViewerControlsFlag: getMobileDeviceViewerControlsFlagMock,
  supportsAndroidNativeViewer: supportsAndroidNativeViewerMock,
}));

let container: HTMLDivElement;
let root: Root;

function renderViewer() {
  root.render(
    <AndroidDeviceViewer
      deviceName="Pixel 9"
      serial="RRCX6069MLD"
      sessionId="android-stream-1"
    />,
  );
}

function dispatchKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  getMobileDeviceViewerControlsFlagMock.mockReturnValue(false);
  readAndroidClipboardMock.mockResolvedValue("");
  readHostClipboardMock.mockResolvedValue("");
  supportsAndroidNativeViewerMock.mockReturnValue(false);
  sendDeviceControlMock.mockResolvedValue(undefined);
  writeAndroidClipboardMock.mockResolvedValue(undefined);
  writeHostClipboardMock.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("AndroidDeviceViewer", () => {
  it("does not render the keyboard bridge or keyboard toggle in mobile browser controls mode", () => {
    getMobileDeviceViewerControlsFlagMock.mockReturnValue(true);

    act(() => {
      renderViewer();
    });

    expect(container.querySelector('textarea[aria-label="Android keyboard bridge"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Show Android keyboard bridge"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Android fullscreen"]')).not.toBeNull();
  });

  it("copies the Android clipboard into the browser clipboard on mobile browsers", async () => {
    getMobileDeviceViewerControlsFlagMock.mockReturnValue(true);
    readAndroidClipboardMock.mockResolvedValue("copied from android");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
      ?? Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      act(() => {
        renderViewer();
      });

      const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy Android clipboard"]');
      expect(copyButton).not.toBeNull();

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith("copied from android");
      expect(writeHostClipboardMock).not.toHaveBeenCalled();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("retries cached Android clipboard text synchronously after a blocked browser copy", async () => {
    getMobileDeviceViewerControlsFlagMock.mockReturnValue(true);
    readAndroidClipboardMock.mockResolvedValue("cached android clipboard");
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
      act(() => {
        renderViewer();
      });

      const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy Android clipboard"]');
      expect(copyButton).not.toBeNull();

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(readAndroidClipboardMock).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledTimes(1);

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(readAndroidClipboardMock).toHaveBeenCalledTimes(1);
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

  it("batches consecutive keyboard characters into one Android text control", async () => {
    vi.useFakeTimers();

    act(() => {
      renderViewer();
    });

    const keyboardButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show Android keyboard bridge"]');
    expect(keyboardButton).not.toBeNull();

    act(() => {
      keyboardButton?.click();
    });

    act(() => {
      for (const key of "hello") {
        dispatchKey(key);
      }
    });

    expect(sendDeviceControlMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(35);
      await Promise.resolve();
    });

    expect(sendDeviceControlMock).toHaveBeenCalledTimes(1);
    expect(sendDeviceControlMock).toHaveBeenCalledWith("android-stream-1", {
      action: "text",
      payload: {
        text: "hello",
      },
    });
  });

  it("flushes buffered text before sending a special Android key", async () => {
    vi.useFakeTimers();

    act(() => {
      renderViewer();
    });

    const keyboardButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show Android keyboard bridge"]');
    act(() => {
      keyboardButton?.click();
      dispatchKey("o");
      dispatchKey("k");
      dispatchKey("Enter");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(sendDeviceControlMock).toHaveBeenCalledTimes(2);
    expect(sendDeviceControlMock).toHaveBeenNthCalledWith(1, "android-stream-1", {
      action: "text",
      payload: {
        text: "ok",
      },
    });
    expect(sendDeviceControlMock).toHaveBeenNthCalledWith(2, "android-stream-1", {
      action: "key",
      payload: {
        keycode: 66,
      },
    });
  });
});
