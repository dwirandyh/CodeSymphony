import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevicePanel } from "./DevicePanel";

const { useDevicesMock } = vi.hoisted(() => ({
  useDevicesMock: vi.fn(),
}));
const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn(),
}));
const { supportsAndroidNativeViewerMock } = vi.hoisted(() => ({
  supportsAndroidNativeViewerMock: vi.fn(),
}));

const startStream = vi.fn();
const stopStream = vi.fn();
const refresh = vi.fn();

vi.mock("../../lib/api", () => ({
  api: {
    runtimeBaseUrl: "http://127.0.0.1:4331",
  },
}));

vi.mock("../../lib/openExternalUrl", () => ({
  isTauriDesktop: () => true,
  openExternalUrl: openExternalUrlMock,
}));

vi.mock("./AndroidDeviceViewer", () => ({
  AndroidDeviceViewer: ({ sessionId }: { sessionId: string }) => (
    <div data-device-viewer="android-native">Android native viewer {sessionId}</div>
  ),
}));

vi.mock("./IosSimulatorViewer", () => ({
  IosSimulatorViewer: ({ sessionId }: { sessionId: string }) => (
    <div data-device-viewer="ios-native">iOS native viewer {sessionId}</div>
  ),
}));

vi.mock("./deviceViewerEnvironment", () => ({
  supportsAndroidNativeViewer: supportsAndroidNativeViewerMock,
}));

vi.mock("../../pages/workspace/hooks/useDevices", () => ({
  useDevices: useDevicesMock,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  supportsAndroidNativeViewerMock.mockReturnValue(true);
  useDevicesMock.mockImplementation(() => ({
    snapshot: {
      devices: [
        {
          id: "android:emulator-5554",
          name: "Pixel 9",
          platform: "android",
          status: "streaming",
          connectionKind: "emulator",
          supportsEmbeddedStream: true,
          supportsControl: true,
          serial: "emulator-5554",
          lastError: null,
        },
        {
          id: "ios-simulator:abc123",
          name: "iPhone 15 Pro",
          platform: "ios-simulator",
          status: "available",
          connectionKind: "simulator",
          supportsEmbeddedStream: true,
          supportsControl: true,
          serial: "ABC123",
          lastError: null,
        },
      ],
      activeSessions: [
        {
          sessionId: "stream-1",
          deviceId: "android:emulator-5554",
          platform: "android",
          viewerUrl: "/api/device-streams/stream-1/viewer",
          controlTransport: "websocket",
          startedAt: new Date().toISOString(),
        },
      ],
      issues: [],
      refreshedAt: new Date().toISOString(),
    },
    loading: false,
    error: null,
    refresh,
    startStream,
    stopStream,
    startingDeviceId: null,
    stoppingSessionId: null,
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DevicePanel", () => {
  it("renders device tabs and native Android viewer", () => {
    act(() => {
      root.render(<DevicePanel onClose={() => {}} />);
    });

    expect(container.textContent).toContain("Devices");
    expect(container.textContent).toContain("Pixel 9");
    expect(container.textContent).toContain("iPhone 15 Pro");
    expect(container.querySelector('[data-device-viewer="android-native"]')).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("falls back to the proxied Android iframe viewer when native decoding is unavailable", () => {
    supportsAndroidNativeViewerMock.mockReturnValue(false);

    act(() => {
      root.render(<DevicePanel onClose={() => {}} />);
    });

    const iframe = container.querySelector("iframe");
    expect(container.querySelector('[data-device-viewer="android-native"]')).toBeNull();
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("src")).toBe("http://127.0.0.1:4331/api/device-streams/stream-1/viewer");
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();

    act(() => {
      root.render(<DevicePanel onClose={onClose} />);
    });

    const button = container.querySelector('button[aria-label="Close Devices"]');
    act(() => {
      (button as HTMLButtonElement).click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state while discovery is in progress", () => {
    useDevicesMock.mockReturnValueOnce({
      snapshot: {
        devices: [],
        activeSessions: [],
        issues: [],
        refreshedAt: new Date(0).toISOString(),
      },
      loading: true,
      error: null,
      refresh,
      startStream,
      stopStream,
      startingDeviceId: null,
      stoppingSessionId: null,
    });

    act(() => {
      root.render(<DevicePanel onClose={() => {}} />);
    });

    expect(container.textContent).toContain("Scanning devices");
    expect(container.textContent).not.toContain("No devices detected");
  });

  it("renders the native iOS simulator viewer when an iOS stream is active", async () => {
    useDevicesMock.mockImplementation(() => ({
      snapshot: {
        devices: [
          {
            id: "ios-simulator:abc123",
            name: "iPhone 15 Pro",
            platform: "ios-simulator",
            status: "streaming",
            connectionKind: "simulator",
            supportsEmbeddedStream: true,
            supportsControl: true,
            serial: "ABC123",
            lastError: null,
          },
        ],
        activeSessions: [
          {
            sessionId: "ios-stream-1",
            deviceId: "ios-simulator:abc123",
            platform: "ios-simulator",
            viewerUrl: "/api/device-streams/ios-stream-1/viewer",
            controlTransport: "websocket",
            startedAt: new Date().toISOString(),
          },
        ],
        issues: [],
        refreshedAt: new Date().toISOString(),
      },
      loading: false,
      error: null,
      refresh,
      startStream,
      stopStream,
      startingDeviceId: null,
      stoppingSessionId: null,
    }));

    await act(async () => {
      root.render(<DevicePanel onClose={() => {}} />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-device-viewer="ios-native"]')).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).not.toContain("WebRTC");
    expect(container.textContent).not.toContain("Bridge WS");
    expect(container.textContent).not.toContain("iOS stream mode");
  });

  it("starts iOS streaming without exposing a mode selector", async () => {
    useDevicesMock.mockImplementation(() => ({
      snapshot: {
        devices: [
          {
            id: "ios-simulator:abc123",
            name: "iPhone 15 Pro",
            platform: "ios-simulator",
            status: "available",
            connectionKind: "simulator",
            supportsEmbeddedStream: true,
            supportsControl: true,
            serial: "ABC123",
            lastError: null,
          },
        ],
        activeSessions: [],
        issues: [],
        refreshedAt: new Date().toISOString(),
      },
      loading: false,
      error: null,
      refresh,
      startStream,
      stopStream,
      startingDeviceId: null,
      stoppingSessionId: null,
    }));

    await act(async () => {
      root.render(<DevicePanel onClose={() => {}} />);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Auto");
    expect(container.textContent).not.toContain("WebRTC");
    expect(container.textContent).not.toContain("Bridge WS");

    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("Start Stream"));
    expect(button).toBeTruthy();

    await act(async () => {
      (button as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(startStream).toHaveBeenCalledWith("ios-simulator:abc123");
  });

  it("shows macOS screen recording guidance for packaged iOS streaming", async () => {
    useDevicesMock.mockImplementation(() => ({
      snapshot: {
        devices: [
          {
            id: "ios-simulator:abc123",
            name: "iPhone 15 Pro",
            platform: "ios-simulator",
            status: "streaming",
            connectionKind: "simulator",
            supportsEmbeddedStream: true,
            supportsControl: true,
            serial: "ABC123",
            lastError: null,
          },
        ],
        activeSessions: [
          {
            sessionId: "ios-stream-1",
            deviceId: "ios-simulator:abc123",
            platform: "ios-simulator",
            viewerUrl: "/api/device-streams/ios-stream-1/viewer",
            controlTransport: "websocket",
            startedAt: new Date().toISOString(),
          },
        ],
        issues: [
          {
            id: "ios-simulator:tcc",
            platform: "ios-simulator",
            severity: "warning",
            message: "Native iOS simulator streaming is unavailable: The user declined TCCs for application, window, display capture",
          },
        ],
        refreshedAt: new Date().toISOString(),
      },
      loading: false,
      error: null,
      refresh,
      startStream,
      stopStream,
      startingDeviceId: null,
      stoppingSessionId: null,
    }));

    await act(async () => {
      root.render(<DevicePanel onClose={() => {}} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Screen Recording required");
    expect(container.textContent).toContain("Grant Screen Recording to CodeSymphony");

    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("Open Settings"));
    expect(button).toBeTruthy();

    await act(async () => {
      (button as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(openExternalUrlMock).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  });
});
