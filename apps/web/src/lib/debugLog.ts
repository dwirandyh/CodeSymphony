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

type DebugLogOptions = {
  threadId?: string | null;
  worktreeId?: string | null;
  force?: boolean;
};

type DebugLogFilters = {
  sourcePrefixes: string[];
  threadId: string | null;
};

let debugSeq = 0;
let persistentVerboseDebugOptIn: boolean | null = null;
let persistentDebugFilters: DebugLogFilters | null = null;

const VERBOSE_DEBUG_SOURCE_PREFIXES = [
  "thread.timeline",
  "thread.stream",
  "thread.workspace",
];

function isVerboseDebugSource(source: string) {
  return VERBOSE_DEBUG_SOURCE_PREFIXES.some((prefix) => source === prefix || source.startsWith(`${prefix}.`));
}

function parseCsvFilter(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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

function readPersistentDebugFilters(): DebugLogFilters {
  if (typeof window === "undefined") {
    return {
      sourcePrefixes: [],
      threadId: null,
    };
  }

  let querySourcePrefixes: string[] = [];
  let queryThreadId: string | null = null;

  try {
    const query = new URLSearchParams(window.location.search);
    querySourcePrefixes = parseCsvFilter(query.get("debugLogSources"));
    queryThreadId = query.get("debugLogThread")?.trim() || null;
  } catch {
    // Ignore URL parsing failures and fall through to localStorage.
  }

  try {
    const storedSourcePrefixes = parseCsvFilter(window.localStorage.getItem("codesymphony.debugLog.sources"));
    const storedThreadId = window.localStorage.getItem("codesymphony.debugLog.threadId")?.trim() || null;
    return {
      sourcePrefixes: querySourcePrefixes.length > 0 ? querySourcePrefixes : storedSourcePrefixes,
      threadId: queryThreadId ?? storedThreadId,
    };
  } catch {
    return {
      sourcePrefixes: querySourcePrefixes,
      threadId: queryThreadId,
    };
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

function getPersistentDebugFilters(): DebugLogFilters {
  if (persistentDebugFilters == null) {
    persistentDebugFilters = readPersistentDebugFilters();
  }

  return persistentDebugFilters;
}

function extractThreadId(data: unknown): string | null {
  if (
    data != null
    && typeof data === "object"
    && "threadId" in data
    && typeof (data as Record<string, unknown>).threadId === "string"
  ) {
    const threadId = ((data as Record<string, unknown>).threadId as string).trim();
    return threadId.length > 0 ? threadId : null;
  }

  return null;
}

function matchesSourcePrefixes(source: string, prefixes: string[]) {
  return prefixes.some((prefix) => source === prefix || source.startsWith(`${prefix}.`));
}

function shouldEmitDebugLog(
  source: string,
  data: unknown,
  options: DebugLogOptions | undefined,
): boolean {
  const filters = getPersistentDebugFilters();
  const matchesExplicitSourceFilter =
    filters.sourcePrefixes.length > 0 && matchesSourcePrefixes(source, filters.sourcePrefixes);

  if (filters.sourcePrefixes.length > 0 && !matchesExplicitSourceFilter) {
    return false;
  }

  const threadFilter = filters.threadId;
  if (threadFilter) {
    const entryThreadId = options?.threadId ?? extractThreadId(data);
    if (entryThreadId !== threadFilter) {
      return false;
    }
  }

  if (options?.force) {
    return true;
  }

  if (isVerboseDebugSource(source) && !isVerboseDebugEnabled() && !matchesExplicitSourceFilter) {
    return false;
  }

  return true;
}

export function debugLog(source: string, message: string, data?: unknown, options?: DebugLogOptions) {
  if (typeof window === "undefined") {
    return;
  }

  if (!shouldEmitDebugLog(source, data, options)) {
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
