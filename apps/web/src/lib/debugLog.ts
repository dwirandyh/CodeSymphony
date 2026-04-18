import { resolveRuntimeApiBase } from "./runtimeUrl";

declare global {
  interface Window {
    __CS_DEBUG_LOG__?: Array<{
      seq: number;
      ts: number;
      source: string;
      message: string;
      data: unknown;
    }>;
  }
}

let debugSeq = 0;

export function debugLog(source: string, message: string, data?: unknown) {
  if (typeof window === "undefined") {
    return;
  }

  const entry = {
    seq: ++debugSeq,
    ts: Math.round(performance.now() * 10) / 10,
    source,
    message,
    data: data ?? null,
  };

  const buffer = window.__CS_DEBUG_LOG__ ?? [];
  buffer.push(entry);
  window.__CS_DEBUG_LOG__ = buffer.slice(-200);

  const body = JSON.stringify([entry]);

  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(`${resolveRuntimeApiBase()}/debug/log`, body);
      return;
    }
  } catch {
    // Fall through to fetch.
  }

  void fetch(`${resolveRuntimeApiBase()}/debug/log`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
    keepalive: true,
  }).catch(() => {});
}
