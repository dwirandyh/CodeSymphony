// Generic client-to-server debug logging utility.
// Sends entries via navigator.sendBeacon (survives blocked main threads)
// and persists them to a server-side log file for offline inspection.

import { resolveRuntimeApiBase } from "./runtimeUrl";

interface DebugLogEntry {
  seq: number;
  ts: number;
  source: string;
  message: string;
  data: unknown;
}

declare global {
  interface Window {
    __CS_DEBUG_LOG__: DebugLogEntry[];
  }
}

let counter = 0;

const BEACON_URL = `${resolveRuntimeApiBase()}/debug/log`;
const RUNTIME_INFO_URL = `${resolveRuntimeApiBase()}/debug/runtime-info`;
let runtimeInfoProbeStarted = false;

if (typeof window !== "undefined" && !window.__CS_DEBUG_LOG__) {
  window.__CS_DEBUG_LOG__ = [];
}

function dispatchDebugEntry(entry: DebugLogEntry): void {
  if (typeof window !== "undefined") {
    if (window.__CS_DEBUG_LOG__.length >= 5000) {
      window.__CS_DEBUG_LOG__.length = 0;
    }
    window.__CS_DEBUG_LOG__.push(entry);
  }

  // Use sendBeacon for immediate, fire-and-forget delivery.
  // Unlike fetch+setTimeout, sendBeacon is not blocked by
  // synchronous infinite re-render loops.
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(
      BEACON_URL,
      new Blob([JSON.stringify([entry])], { type: "text/plain" }),
    );
  }
}

function probeRuntimeInfoOnce(): void {
  if (runtimeInfoProbeStarted || typeof window === "undefined" || typeof fetch === "undefined") {
    return;
  }
  runtimeInfoProbeStarted = true;

  void fetch(RUNTIME_INFO_URL)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null);
      const runtimeInfo = payload && typeof payload === "object" && "data" in payload
        ? (payload as { data: unknown }).data
        : payload;
      const entry: DebugLogEntry = {
        seq: ++counter,
        ts: performance.now(),
        source: "debugLog",
        message: "runtime-info",
        data: runtimeInfo,
      };
      dispatchDebugEntry(entry);
    })
    .catch((error) => {
      const entry: DebugLogEntry = {
        seq: ++counter,
        ts: performance.now(),
        source: "debugLog",
        message: "runtime-info-fetch-failed",
        data: {
          error: error instanceof Error ? error.message : String(error),
          runtimeInfoUrl: RUNTIME_INFO_URL,
        },
      };
      dispatchDebugEntry(entry);
    });
}

export function debugLog(source: string, message: string, data?: unknown): void {
  const entry: DebugLogEntry = {
    seq: ++counter,
    ts: performance.now(),
    source,
    message,
    data,
  };

  dispatchDebugEntry(entry);

  console.warn("[CS-DEBUG]", `#${entry.seq}`, source, message, data);
}

probeRuntimeInfoOnce();
