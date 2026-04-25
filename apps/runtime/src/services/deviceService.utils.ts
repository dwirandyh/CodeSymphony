import type { DeviceConnectionKind, DeviceSummary } from "@codesymphony/shared-types";

export const ANDROID_VIEWER_WS_PLACEHOLDER = "__DEVICE_WS_PROXY__";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

const ANDROID_INPUT_TEXT_MAX_SEGMENT_LENGTH = 240;
const ANDROID_INPUT_TEXT_ESCAPE_PATTERN = /([\\%&|<>;(){}\[\]*?!~$"'`])/g;

export function escapeAndroidInputText(value: string): string {
  return value
    .replace(ANDROID_INPUT_TEXT_ESCAPE_PATTERN, "\\$1")
    .replace(/ /g, "%s");
}

export type AndroidInputTextCommand =
  | {
    type: "key";
    value: number;
  }
  | {
    type: "text";
    value: string;
  };

export function buildAndroidInputTextCommands(value: string): AndroidInputTextCommand[] {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const commands: AndroidInputTextCommand[] = [];
  let segment = "";

  const flushSegment = () => {
    if (segment.length === 0) {
      return;
    }

    commands.push({
      type: "text",
      value: escapeAndroidInputText(segment),
    });
    segment = "";
  };

  for (const char of normalized) {
    if (char === "\n") {
      flushSegment();
      commands.push({ type: "key", value: 66 });
      continue;
    }

    if (char === "\t") {
      flushSegment();
      commands.push({ type: "key", value: 61 });
      continue;
    }

    segment += char;
    if (segment.length >= ANDROID_INPUT_TEXT_MAX_SEGMENT_LENGTH) {
      flushSegment();
    }
  }

  flushSegment();
  return commands;
}

export type RememberedAndroidDevice = {
  device: DeviceSummary;
  lastSeenAt: number;
};

export function shouldRetainMissingAndroidSession(lastSeenAt: number, now: number, graceMs: number): boolean {
  return now - lastSeenAt <= graceMs;
}

export function resolveRememberedAndroidDevice(
  rememberedDevice: RememberedAndroidDevice,
  hasSession: boolean,
  now: number,
  graceMs: number,
): {
  device: DeviceSummary | null;
  expired: boolean;
} {
  if (!shouldRetainMissingAndroidSession(rememberedDevice.lastSeenAt, now, graceMs)) {
    return {
      device: null,
      expired: true,
    };
  }

  return {
    device: {
      ...rememberedDevice.device,
      lastError: hasSession
        ? "adb connection dropped. Waiting for the Android device to reconnect."
        : "Android device temporarily unavailable.",
      status: hasSession ? "connecting" : "offline",
    },
    expired: false,
  };
}

function decodeAndroidServiceCallParcel(output: string): Uint8Array {
  const words: number[] = [];

  for (const line of output.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\b[0-9a-fA-F]{8}\b/g)].map((match) => match[0]);
    if (matches.length === 0) {
      continue;
    }

    for (const word of matches) {
      words.push(Number.parseInt(word, 16) >>> 0);
    }
  }

  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < words.length; index += 1) {
    view.setUint32(index * 4, words[index] ?? 0, true);
  }

  return bytes;
}

function isMostlyPrintable(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  let printableCount = 0;
  for (const char of value) {
    if (char === "\n" || char === "\r" || char === "\t") {
      printableCount += 1;
      continue;
    }

    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint !== 0x7f) {
      printableCount += 1;
    }
  }

  return printableCount / value.length >= 0.85;
}

export function parseAndroidClipboardBooleanServiceCall(output: string): boolean | null {
  const bytes = decodeAndroidServiceCallParcel(output);
  if (bytes.byteLength < 8) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt32(4, true) !== 0;
}

export function parseAndroidClipboardServiceCallOutput(output: string): string | null {
  const bytes = decodeAndroidServiceCallParcel(output);
  if (bytes.byteLength < 12) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let bestCandidate: { offset: number; text: string } | null = null;

  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    const length = view.getInt32(offset, true);
    if (length <= 0 || length > bytes.byteLength - offset - 4) {
      continue;
    }

    const payload = bytes.subarray(offset + 4, offset + 4 + length);
    let text: string;
    try {
      text = utf8Decoder.decode(payload);
    } catch {
      continue;
    }

    if (text.length === 0 || text.includes("\u0000") || text === "text/plain" || !isMostlyPrintable(text)) {
      continue;
    }

    if (!bestCandidate || offset > bestCandidate.offset) {
      bestCandidate = { offset, text };
    }
  }

  return bestCandidate?.text ?? null;
}
