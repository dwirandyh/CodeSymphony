import { describe, expect, it } from "vitest";
import {
  ANDROID_VIEWER_WS_PLACEHOLDER,
  buildAndroidProxyViewerUrl,
  buildAndroidWsScrcpyViewerUrl,
  parseAdbDevicesOutput,
  parseSimctlDevicesOutput,
} from "../src/services/deviceService.utils";

describe("deviceService.utils", () => {
  it("parses adb device output with metadata", () => {
    const devices = parseAdbDevicesOutput([
      "List of devices attached",
      "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
      "192.168.1.20:5555 offline transport_id:3",
    ].join("\n"));

    expect(devices).toEqual([
      {
        serial: "emulator-5554",
        state: "device",
        model: "sdk gphone64 arm64",
        deviceName: "emu64a",
        transportId: "1",
        connectionKind: "emulator",
      },
      {
        serial: "192.168.1.20:5555",
        state: "offline",
        model: null,
        deviceName: null,
        transportId: "3",
        connectionKind: "wifi",
      },
    ]);
  });

  it("builds a ws-scrcpy viewer url that proxies adb over websocket", () => {
    const viewerUrl = buildAndroidWsScrcpyViewerUrl("http://127.0.0.1:8765/", "emulator-5554");
    const url = new URL(viewerUrl);
    const hash = url.hash.startsWith("#!") ? url.hash.slice(2) : url.hash.slice(1);
    const params = new URLSearchParams(hash);

    expect(params.get("action")).toBe("stream");
    expect(params.get("udid")).toBe("emulator-5554");
    expect(params.get("player")).toBe("webcodecs");

    const wsProxyUrl = new URL(params.get("ws") ?? "");
    expect(wsProxyUrl.protocol).toBe("ws:");
    expect(wsProxyUrl.searchParams.get("action")).toBe("proxy-adb");
    expect(wsProxyUrl.searchParams.get("remote")).toBe("tcp:8886");
    expect(wsProxyUrl.searchParams.get("udid")).toBe("emulator-5554");
  });

  it("builds a runtime viewer url that keeps the websocket target server-side", () => {
    const viewerUrl = buildAndroidProxyViewerUrl("stream-1", "emulator-5554");
    const [path, rawHash] = viewerUrl.split("#!");
    const params = new URLSearchParams(rawHash ?? "");

    expect(path).toBe("/api/device-streams/stream-1/viewer/index.html");
    expect(params.get("action")).toBe("stream");
    expect(params.get("udid")).toBe("emulator-5554");
    expect(params.get("player")).toBe("webcodecs");
    expect(params.get("ws")).toBe(ANDROID_VIEWER_WS_PLACEHOLDER);
  });

  it("parses simctl json output for booted simulators", () => {
    const simulators = parseSimctlDevicesOutput(JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
          {
            udid: "4F8060B7-142F-4628-880D-FF1A74C20B91",
            name: "iPhone 17 Pro",
            state: "Booted",
            isAvailable: true,
          },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-18-1": [
          {
            udid: "12345678-142F-4628-880D-FF1A74C20B92",
            name: "iPhone 16",
            state: "Shutdown",
            isAvailable: true,
          },
        ],
      },
    }));

    expect(simulators).toEqual([
      {
        udid: "4F8060B7-142F-4628-880D-FF1A74C20B91",
        name: "iPhone 17 Pro",
        state: "Booted",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
        iosVersion: "18.2",
        isAvailable: true,
      },
      {
        udid: "12345678-142F-4628-880D-FF1A74C20B92",
        name: "iPhone 16",
        state: "Shutdown",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-1",
        iosVersion: "18.1",
        isAvailable: true,
      },
    ]);
  });
});
