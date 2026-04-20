import type { DeviceConnectionKind } from "@codesymphony/shared-types";

export const ANDROID_VIEWER_WS_PLACEHOLDER = "__DEVICE_WS_PROXY__";

export type ParsedAdbDevice = {
  serial: string;
  state: string;
  model: string | null;
  deviceName: string | null;
  transportId: string | null;
  connectionKind: DeviceConnectionKind;
};

export type ParsedIosSimulator = {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  iosVersion: string | null;
  isAvailable: boolean;
};

function normalizeAndroidNamePart(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseIosVersionFromRuntime(runtime: string): string | null {
  const marker = "iOS-";
  const idx = runtime.indexOf(marker);
  if (idx < 0) {
    return null;
  }

  const version = runtime.slice(idx + marker.length).replace(/-/g, ".");
  return version.trim().length > 0 ? version : null;
}

export function resolveAdbConnectionKind(serial: string): DeviceConnectionKind {
  if (serial.startsWith("emulator-")) {
    return "emulator";
  }

  if (serial.includes(":")) {
    return "wifi";
  }

  return "usb";
}

export function parseAdbDevicesOutput(output: string): ParsedAdbDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("List of devices attached"))
    .map((line) => {
      const parts = line.split(/\s+/);
      const [serial, state, ...metadataParts] = parts;

      if (!serial || !state) {
        return null;
      }

      const metadata = new Map<string, string>();
      for (const part of metadataParts) {
        const colonIdx = part.indexOf(":");
        if (colonIdx <= 0) {
          continue;
        }

        metadata.set(part.slice(0, colonIdx), part.slice(colonIdx + 1));
      }

      return {
        serial,
        state,
        model: normalizeAndroidNamePart(metadata.get("model") ?? null),
        deviceName: normalizeAndroidNamePart(metadata.get("device") ?? null),
        transportId: metadata.get("transport_id") ?? null,
        connectionKind: resolveAdbConnectionKind(serial),
      } satisfies ParsedAdbDevice;
    })
    .filter((value): value is ParsedAdbDevice => value !== null);
}

export function parseSimctlDevicesOutput(output: string): ParsedIosSimulator[] {
  const payload = JSON.parse(output) as {
    devices?: Record<string, Array<{
      udid?: unknown;
      name?: unknown;
      state?: unknown;
      isAvailable?: unknown;
    }>>;
  };
  const runtimes = payload.devices ?? {};

  return Object.entries(runtimes).flatMap(([runtime, devices]) =>
    (Array.isArray(devices) ? devices : []).flatMap((device) => {
      const udid = typeof device.udid === "string" ? device.udid.trim() : "";
      const name = typeof device.name === "string" ? device.name.trim() : "";
      const state = typeof device.state === "string" ? device.state.trim() : "";
      const isAvailable = typeof device.isAvailable === "boolean" ? device.isAvailable : true;

      if (!udid || !name || !state) {
        return [];
      }

      return [{
        udid,
        name,
        state,
        runtime,
        iosVersion: parseIosVersionFromRuntime(runtime),
        isAvailable,
      } satisfies ParsedIosSimulator];
    })
  );
}

export function buildAndroidWsScrcpyViewerUrl(baseUrl: string, udid: string, player = "webcodecs"): string {
  const viewerUrl = new URL(baseUrl);
  const wsProtocol = viewerUrl.protocol === "https:" ? "wss:" : "ws:";
  const wsProxyUrl = new URL(viewerUrl.toString());
  wsProxyUrl.protocol = wsProtocol;
  wsProxyUrl.search = "";
  wsProxyUrl.hash = "";
  wsProxyUrl.searchParams.set("action", "proxy-adb");
  wsProxyUrl.searchParams.set("remote", "tcp:8886");
  wsProxyUrl.searchParams.set("udid", udid);

  const hashParams = new URLSearchParams({
    action: "stream",
    udid,
    player,
    ws: wsProxyUrl.toString(),
  });

  viewerUrl.search = "";
  viewerUrl.hash = `!${hashParams.toString()}`;
  return viewerUrl.toString();
}

export function buildAndroidProxyViewerUrl(sessionId: string, udid: string, player = "webcodecs"): string {
  const hashParams = new URLSearchParams({
    action: "stream",
    udid,
    player,
    ws: ANDROID_VIEWER_WS_PLACEHOLDER,
  });

  return `/api/device-streams/${encodeURIComponent(sessionId)}/viewer/index.html#!${hashParams.toString()}`;
}
