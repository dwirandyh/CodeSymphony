import { debugLog } from "./debugLog";

export type ThreadNavigationPerfEntry = {
  ts: string;
  navId: string;
  event: string;
  threadId?: string;
  worktreeId?: string | null;
  data?: Record<string, unknown>;
};

type ThreadNavigationPerfApi = {
  entries: ThreadNavigationPerfEntry[];
  clear: () => void;
  dump: () => string;
};

type WindowWithThreadNavigationPerf = Window & {
  __CS_THREAD_NAV_PERF__?: ThreadNavigationPerfApi;
};

const MAX_ENTRIES = 500;

function getWindow(): WindowWithThreadNavigationPerf | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window as WindowWithThreadNavigationPerf;
}

function readLocalStorageFlag(key: string): string | null {
  const currentWindow = getWindow();
  const storage = currentWindow?.localStorage;
  if (!storage || typeof storage.getItem !== "function") {
    return null;
  }

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function isThreadNavigationPerfEnabled(): boolean {
  const currentWindow = getWindow();
  if (!currentWindow) {
    return false;
  }

  const query = new URLSearchParams(currentWindow.location.search);
  if (query.get("csDebugThreadNav") === "1") {
    return true;
  }

  return readLocalStorageFlag("cs.debug.threadNavigation") === "1";
}

function ensureThreadNavigationPerfApi(): ThreadNavigationPerfApi | null {
  const currentWindow = getWindow();
  if (!currentWindow || !isThreadNavigationPerfEnabled()) {
    return null;
  }

  if (!currentWindow.__CS_THREAD_NAV_PERF__) {
    const entries: ThreadNavigationPerfEntry[] = [];
    currentWindow.__CS_THREAD_NAV_PERF__ = {
      entries,
      clear: () => {
        entries.length = 0;
      },
      dump: () => JSON.stringify(entries, null, 2),
    };
  }

  return currentWindow.__CS_THREAD_NAV_PERF__;
}

export function pushThreadNavigationPerf(entry: Omit<ThreadNavigationPerfEntry, "ts">): void {
  const api = ensureThreadNavigationPerfApi();
  if (!api) {
    return;
  }

  const payload: ThreadNavigationPerfEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };

  api.entries.push(payload);
  if (api.entries.length > MAX_ENTRIES) {
    api.entries.splice(0, api.entries.length - MAX_ENTRIES);
  }

  debugLog("thread.nav.perf", entry.event, payload);

  // eslint-disable-next-line no-console
  console.debug("[cs-thread-nav]", payload);
}

export function getThreadNavigationPerfEntries(): ThreadNavigationPerfEntry[] {
  const api = ensureThreadNavigationPerfApi();
  if (!api) {
    return [];
  }

  return [...api.entries];
}

export function clearThreadNavigationPerfEntries(): void {
  const api = ensureThreadNavigationPerfApi();
  if (!api) {
    return;
  }

  api.clear();
}
