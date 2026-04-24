import { describe, expect, it } from "vitest";
import {
  ANDROID_VIEWER_WS_PLACEHOLDER,
  buildAndroidInputTextCommands,
  buildAndroidProxyViewerUrl,
  buildAndroidWsScrcpyViewerUrl,
  escapeAndroidInputText,
  parseAdbDevicesOutput,
  parseAndroidClipboardBooleanServiceCall,
  parseAndroidClipboardServiceCallOutput,
  parseSimctlDevicesOutput,
  resolveRememberedAndroidDevice,
  shouldRetainMissingAndroidSession,
} from "../src/services/deviceService.utils";

function createClipboardServiceOutput(text: string): string {
  const mimeType = "text/plain";
  const mimeBytes = Buffer.from(mimeType, "utf8");
  const textBytes = Buffer.from(text, "utf8");
  const int32 = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value, 0);
    return buffer;
  };
  const align = (byteLength: number) => Buffer.alloc((4 - (byteLength % 4)) % 4);
  const bytes = Buffer.concat([
    int32(0),
    int32(mimeBytes.length),
    mimeBytes,
    align(4 + mimeBytes.length),
    int32(0),
    int32(textBytes.length),
    textBytes,
    align(4 + textBytes.length),
  ]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const lines = ["Result: Parcel("];
  for (let lineOffset = 0; lineOffset < bytes.length; lineOffset += 16) {
    const words: string[] = [];
    for (let wordOffset = lineOffset; wordOffset < Math.min(lineOffset + 16, bytes.length); wordOffset += 4) {
      words.push(view.getUint32(wordOffset, true).toString(16).padStart(8, "0"));
    }
    lines.push(`0x${lineOffset.toString(16).padStart(8, "0")}: ${words.join(" ")}`);
  }
  lines[lines.length - 1] = `${lines[lines.length - 1]})`;

  return lines.join("\n");
}

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

  it("parses clipboard boolean results from adb service calls", () => {
    expect(parseAndroidClipboardBooleanServiceCall("Result: Parcel(\t00000000 00000001   '........')")).toBe(true);
    expect(parseAndroidClipboardBooleanServiceCall("Result: Parcel(\t00000000 00000000   '........')")).toBe(false);
  });

  it("extracts clipboard text from Samsung clipboard service output", () => {
    const output = createClipboardServiceOutput("DEVICE-CLIP-TEXT");
    expect(parseAndroidClipboardServiceCallOutput(output)).toBe("DEVICE-CLIP-TEXT");
  });

  it("escapes Android input text for adb shell input", () => {
    expect(escapeAndroidInputText("A B&C%")).toBe("A%sB\\&C\\%");
  });

  it("builds Android adb text commands with newline and tab fallbacks", () => {
    expect(buildAndroidInputTextCommands("Line 1\n\tLine 2")).toEqual([
      { type: "text", value: "Line%s1" },
      { type: "key", value: 66 },
      { type: "key", value: 61 },
      { type: "text", value: "Line%s2" },
    ]);
  });

  it("keeps recently missing Android sessions alive during the adb grace period", () => {
    expect(shouldRetainMissingAndroidSession(1_000, 20_500, 20_000)).toBe(true);
    expect(shouldRetainMissingAndroidSession(1_000, 21_001, 20_000)).toBe(false);
  });

  it("restores recently seen Android devices as connecting while a session is active", () => {
    expect(resolveRememberedAndroidDevice({
      device: {
        id: "android:RRCX6069MLD",
        name: "SM A556E",
        platform: "android",
        status: "streaming",
        connectionKind: "usb",
        supportsEmbeddedStream: true,
        supportsControl: true,
        serial: "RRCX6069MLD",
        lastError: null,
      },
      lastSeenAt: 10_000,
    }, true, 25_000, 20_000)).toEqual({
      device: {
        id: "android:RRCX6069MLD",
        name: "SM A556E",
        platform: "android",
        status: "connecting",
        connectionKind: "usb",
        supportsEmbeddedStream: true,
        supportsControl: true,
        serial: "RRCX6069MLD",
        lastError: "adb connection dropped. Waiting for the Android device to reconnect.",
      },
      expired: false,
    });
  });

  it("expires remembered Android devices once the grace period elapses", () => {
    expect(resolveRememberedAndroidDevice({
      device: {
        id: "android:RRCX6069MLD",
        name: "SM A556E",
        platform: "android",
        status: "available",
        connectionKind: "usb",
        supportsEmbeddedStream: true,
        supportsControl: true,
        serial: "RRCX6069MLD",
        lastError: null,
      },
      lastSeenAt: 10_000,
    }, false, 31_000, 20_000)).toEqual({
      device: null,
      expired: true,
    });
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
