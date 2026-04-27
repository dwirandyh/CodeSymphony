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
    __CS_DEBUG_LOG_ENABLED__?: boolean;
  }
}

let debugSeq = 0;
let persistentVerboseDebugOptIn: boolean | null = null;

const VERBOSE_DEBUG_SOURCE_PREFIXES = [
  "thread.timeline",
];

function isVerboseDebugSource(source: string) {
  return VERBOSE_DEBUG_SOURCE_PREFIXES.some((prefix) => source === prefix || source.startsWith(`${prefix}.`));
}

function readPersistentVerboseDebugOptIn() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const query = new URLSearchParams(window.location.search);
    const queryValue = query.get("debugLog")?.trim().toLowerCase();
    if (queryValue === "1" || queryValue === "true") {
      return true;
    }
  } catch {
    // Ignore URL parsing failures and fall through to localStorage.
  }

  try {
    const localValue = window.localStorage.getItem("codesymphony.debugLog")?.trim().toLowerCase();
    return localValue === "1" || localValue === "true";
  } catch {
    return false;
  }
}

function isVerboseDebugEnabled() {
  if (typeof window === "undefined") {
    return false;
  }

  if (window.__CS_DEBUG_LOG_ENABLED__ === true) {
    return true;
  }

  if (persistentVerboseDebugOptIn == null) {
    persistentVerboseDebugOptIn = readPersistentVerboseDebugOptIn();
  }

  return persistentVerboseDebugOptIn;
}

export function debugLog(source: string, message: string, data?: unknown) {
  if (typeof window === "undefined") {
    return;
  }

  if (isVerboseDebugSource(source) && !isVerboseDebugEnabled()) {
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
