declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isDesktopRuntimeWindow(windowRef: Window): boolean {
  if (windowRef.__TAURI_INTERNALS__) return true;
  // Tauri production can use a non-http(s) protocol (e.g. "tauri:").
  return windowRef.location.protocol !== "http:" && windowRef.location.protocol !== "https:";
}

const WEB_RUNTIME_PORT = 4331;
const DESKTOP_RUNTIME_PORT = 4321;

export function resolveRuntimeApiBase(): string {
  if (import.meta.env.VITE_RUNTIME_URL) return import.meta.env.VITE_RUNTIME_URL;
  if (typeof window === "undefined") return `http://127.0.0.1:${WEB_RUNTIME_PORT}/api`;
  if (isDesktopRuntimeWindow(window)) return `http://127.0.0.1:${DESKTOP_RUNTIME_PORT}/api`;
  // Vite dev server → point to runtime on known port
  if (import.meta.env.DEV) {
    return `${window.location.protocol}//${window.location.hostname}:${WEB_RUNTIME_PORT}/api`;
  }
  // Production build served from runtime → same origin
  return `${window.location.origin}/api`;
}

export function resolveRuntimeApiBases(): string[] {
  const primary = resolveRuntimeApiBase();

  if (typeof window === "undefined") {
    return [primary];
  }

  if (import.meta.env.VITE_RUNTIME_URL) {
    return [primary];
  }

  if (isDesktopRuntimeWindow(window) || !import.meta.env.DEV) {
    return [primary];
  }

  const webBase = `${window.location.protocol}//${window.location.hostname}:${WEB_RUNTIME_PORT}/api`;
  const desktopBase = `${window.location.protocol}//${window.location.hostname}:${DESKTOP_RUNTIME_PORT}/api`;

  return Array.from(new Set([primary, webBase, desktopBase]));
}
