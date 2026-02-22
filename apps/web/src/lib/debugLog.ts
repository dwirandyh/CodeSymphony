// Generic client-to-server debug logging utility.
// Sends entries via navigator.sendBeacon (survives blocked main threads)
// and persists them to a server-side log file for offline inspection.

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

const RUNTIME_BASE =
  typeof window === "undefined"
    ? "http://127.0.0.1:4321/api"
    : `${window.location.protocol}//${window.location.hostname}:4321/api`;

const BEACON_URL = `${RUNTIME_BASE}/debug/log`;

if (typeof window !== "undefined" && !window.__CS_DEBUG_LOG__) {
  window.__CS_DEBUG_LOG__ = [];
}

export function debugLog(source: string, message: string, data?: unknown): void {
  const entry: DebugLogEntry = {
    seq: ++counter,
    ts: performance.now(),
    source,
    message,
    data,
  };

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

  console.warn("[CS-DEBUG]", `#${entry.seq}`, source, message, data);
}
