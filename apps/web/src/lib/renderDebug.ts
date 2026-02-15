type RenderDebugEntry = {
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

type WindowWithRenderDebug = Window & {
  __CS_RENDER_DEBUG__?: RenderDebugApi;
};

const MAX_ENTRIES = 2000;

function getWindow(): WindowWithRenderDebug | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window as WindowWithRenderDebug;
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

  return currentWindow.localStorage.getItem("cs.debug.render") === "1";
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

  // Keep immediate visibility for local diagnosis.
  // eslint-disable-next-line no-console
  console.debug("[cs-render-debug]", payload);
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
