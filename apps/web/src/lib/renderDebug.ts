export type RenderDebugEntry = {
  ts: string;
  source: string;
  event: string;
  messageId?: string;
  details?: Record<string, unknown>;
};

type RenderDebugApi = {
  entries: RenderDebugEntry[];
  clear: () => void;
  dump: () => string;
};

type RenderDebugListener = (entries: RenderDebugEntry[]) => void;

type WindowWithRenderDebug = Window & {
  __CS_RENDER_DEBUG__?: RenderDebugApi;
};

const MAX_ENTRIES = 2000;
const listeners = new Set<RenderDebugListener>();

function notifyListenersAsync(entries: RenderDebugEntry[]): void {
  const snapshot = [...entries];
  const notify = () => {
    listeners.forEach((listener) => listener(snapshot));
  };

  if (typeof queueMicrotask === "function") {
    queueMicrotask(notify);
    return;
  }

  setTimeout(notify, 0);
}

function getWindow(): WindowWithRenderDebug | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window as WindowWithRenderDebug;
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

export function isRenderDebugEnabled(): boolean {
  const currentWindow = getWindow();
  if (!currentWindow) {
    return false;
  }

  const query = new URLSearchParams(currentWindow.location.search);
  if (query.get("csDebugRender") === "1") {
    return true;
  }

  return readLocalStorageFlag("cs.debug.render") === "1";
}

function ensureRenderDebugApi(): RenderDebugApi | null {
  const currentWindow = getWindow();
  if (!currentWindow || !isRenderDebugEnabled()) {
    return null;
  }

  if (!currentWindow.__CS_RENDER_DEBUG__) {
    const entries: RenderDebugEntry[] = [];
    currentWindow.__CS_RENDER_DEBUG__ = {
      entries,
      clear: () => {
        entries.length = 0;
        notifyListenersAsync([]);
      },
      dump: () => JSON.stringify(entries, null, 2),
    };
  }

  return currentWindow.__CS_RENDER_DEBUG__;
}

export function pushRenderDebug(entry: Omit<RenderDebugEntry, "ts">): void {
  const api = ensureRenderDebugApi();
  if (!api) {
    return;
  }

  const payload: RenderDebugEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };

  api.entries.push(payload);
  if (api.entries.length > MAX_ENTRIES) {
    api.entries.splice(0, api.entries.length - MAX_ENTRIES);
  }
  notifyListenersAsync(api.entries);

  // Keep immediate visibility for local diagnosis.
  // eslint-disable-next-line no-console
  console.debug("[cs-render-debug]", payload);
}

export function getRenderDebugEntries(): RenderDebugEntry[] {
  const api = ensureRenderDebugApi();
  if (!api) {
    return [];
  }

  return [...api.entries];
}

export function clearRenderDebugEntries(): void {
  const api = ensureRenderDebugApi();
  if (!api) {
    return;
  }

  api.clear();
}

export function subscribeRenderDebug(listener: RenderDebugListener): () => void {
  listeners.add(listener);
  listener(getRenderDebugEntries());
  return () => {
    listeners.delete(listener);
  };
}

export async function copyRenderDebugLog(): Promise<boolean> {
  const api = ensureRenderDebugApi();
  const currentWindow = getWindow();
  if (!api || !currentWindow) {
    return false;
  }

  if (typeof currentWindow.navigator.clipboard?.writeText !== "function") {
    return false;
  }

  await currentWindow.navigator.clipboard.writeText(api.dump());
  return true;
}
