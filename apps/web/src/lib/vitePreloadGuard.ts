declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type VitePreloadErrorEvent = Event & {
  payload?: unknown;
};

function isDesktopShellWindow(windowRef: Window): boolean {
  if (typeof windowRef.__TAURI_INTERNALS__ !== "undefined") {
    return true;
  }

  return windowRef.location.protocol !== "http:" && windowRef.location.protocol !== "https:";
}

function isIgnorableDesktopShellPreloadError(error: unknown): boolean {
  return error instanceof Error && /^Unable to preload CSS for \/assets\//.test(error.message);
}

export function installDesktopShellVitePreloadGuard(windowRef: Window = window): (() => void) | null {
  if (!isDesktopShellWindow(windowRef)) {
    return null;
  }

  const handlePreloadError = (event: Event) => {
    const preloadErrorEvent = event as VitePreloadErrorEvent;
    if (!isIgnorableDesktopShellPreloadError(preloadErrorEvent.payload)) {
      return;
    }

    preloadErrorEvent.preventDefault();
  };

  windowRef.addEventListener("vite:preloadError", handlePreloadError);

  return () => {
    windowRef.removeEventListener("vite:preloadError", handlePreloadError);
  };
}
