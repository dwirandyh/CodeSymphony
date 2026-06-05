import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInventorySnapshot } from "@codesymphony/shared-types";
import { useDevices } from "./useDevices";

const {
  debugLogMock,
  getDevicesMock,
  streamDevicesMock,
} = vi.hoisted(() => ({
  debugLogMock: vi.fn(),
  getDevicesMock: vi.fn(),
  streamDevicesMock: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  api: {
    getDevices: getDevicesMock,
    streamDevices: streamDevicesMock,
  },
}));

vi.mock("../../../lib/debugLog", () => ({
  debugLog: (...args: unknown[]) => debugLogMock(...args),
}));

class MockEventSource {
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  close = vi.fn();
}

const EMPTY_SNAPSHOT: DeviceInventorySnapshot = {
  devices: [],
  activeSessions: [],
  issues: [],
  refreshedAt: new Date(0).toISOString(),
};

let container: HTMLDivElement;
let root: Root;

function HookHarness() {
  const { snapshot, loading, error } = useDevices();

  return (
    <div
      data-device-count={String(snapshot.devices.length)}
      data-error={error ?? ""}
      data-loading={loading ? "true" : "false"}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  streamDevicesMock.mockReturnValue(new MockEventSource());
  debugLogMock.mockReset();
  getDevicesMock.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function renderHook() {
  act(() => {
    root.render(<HookHarness />);
  });
}

describe("useDevices", () => {
  it("applies the first fetched snapshot", async () => {
    getDevicesMock.mockResolvedValue({
      ...EMPTY_SNAPSHOT,
      devices: [
        {
          id: "ios-simulator:1",
          name: "iPhone",
          platform: "ios-simulator",
          status: "available",
          connectionKind: "simulator",
          supportsEmbeddedStream: true,
          supportsControl: true,
          serial: "1",
          lastError: null,
        },
      ],
      refreshedAt: "2026-01-01T00:00:00.000Z",
    } satisfies DeviceInventorySnapshot);

    renderHook();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-device-count")).toBe("1");
    expect(container.firstElementChild?.getAttribute("data-error")).toBe("");
  });

  it("times out a hung initial fetch instead of leaving loading stuck forever", async () => {
    getDevicesMock.mockImplementation((signal?: AbortSignal) =>
      new Promise<DeviceInventorySnapshot>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    );

    renderHook();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
    });

    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(container.firstElementChild?.getAttribute("data-error")).toBe("Device discovery timed out after 5000ms");
    expect(streamDevicesMock).toHaveBeenCalled();
  });
});
