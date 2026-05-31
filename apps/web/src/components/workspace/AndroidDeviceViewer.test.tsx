import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AndroidDeviceViewer } from "./AndroidDeviceViewer";

const { getMobileDeviceViewerControlsFlagMock, supportsAndroidNativeViewerMock } = vi.hoisted(() => ({
  getMobileDeviceViewerControlsFlagMock: vi.fn(),
  supportsAndroidNativeViewerMock: vi.fn(),
}));
const { sendDeviceControlMock } = vi.hoisted(() => ({
  sendDeviceControlMock: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    readAndroidClipboard: vi.fn().mockResolvedValue(""),
    runtimeBaseUrl: "http://127.0.0.1:4331",
    sendDeviceControl: sendDeviceControlMock,
    writeAndroidClipboard: vi.fn().mockResolvedValue(undefined),
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
  supportsAndroidNativeViewerMock.mockReturnValue(false);
  sendDeviceControlMock.mockResolvedValue(undefined);
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
