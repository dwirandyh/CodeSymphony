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

function getViteEnv(): {
  VITE_RUNTIME_URL?: string;
  VITE_DEV_PORT?: string;
  DEV?: boolean;
} {
  const meta = import.meta as ImportMeta & {
    env?: {
      VITE_RUNTIME_URL?: string;
      VITE_DEV_PORT?: string;
      DEV?: boolean;
    };
  };

  return meta.env ?? {};
}

function getWebDevPort(viteEnv: { VITE_DEV_PORT?: string }): string {
  return viteEnv.VITE_DEV_PORT ?? "5173";
}

function isWebDevServerWindow(
  windowRef: Window,
  viteEnv: { VITE_DEV_PORT?: string; DEV?: boolean },
): boolean {
  if (windowRef.location.port === getWebDevPort(viteEnv)) {
    return true;
  }

  return viteEnv.DEV === true
    && windowRef.location.port !== String(WEB_RUNTIME_PORT)
    && windowRef.location.port !== String(DESKTOP_RUNTIME_PORT);
}

function isDesktopDevFallbackWindow(windowRef: Window, viteEnv: { VITE_DEV_PORT?: string }): boolean {
  return windowRef.location.port === String(DESKTOP_RUNTIME_PORT)
    && getWebDevPort(viteEnv) !== String(DESKTOP_RUNTIME_PORT);
}

export function resolveRuntimeApiBase(): string {
  const viteEnv = getViteEnv();
  if (viteEnv.VITE_RUNTIME_URL) return viteEnv.VITE_RUNTIME_URL;
  if (typeof window === "undefined") return `http://127.0.0.1:${WEB_RUNTIME_PORT}/api`;
  if (isDesktopRuntimeWindow(window)) return `http://127.0.0.1:${DESKTOP_RUNTIME_PORT}/api`;
  if (isDesktopDevFallbackWindow(window, viteEnv)) {
    return `${window.location.protocol}//${window.location.hostname}:${DESKTOP_RUNTIME_PORT}/api`;
  }
  // Vite dev server → point to runtime on known port.
  if (isWebDevServerWindow(window, viteEnv)) {
    return `${window.location.protocol}//${window.location.hostname}:${WEB_RUNTIME_PORT}/api`;
  }
  // Production build served from runtime → same origin
  return `${window.location.origin}/api`;
}

export function resolveRuntimeApiBases(): string[] {
  const viteEnv = getViteEnv();
  const primary = resolveRuntimeApiBase();

  if (typeof window === "undefined") {
    return [primary];
  }

  if (viteEnv.VITE_RUNTIME_URL) {
    return [primary];
  }

  if (isDesktopDevFallbackWindow(window, viteEnv)) {
    return [primary];
  }

  if (isDesktopRuntimeWindow(window) || !isWebDevServerWindow(window, viteEnv)) {
    return [primary];
  }

  const webBase = `${window.location.protocol}//${window.location.hostname}:${WEB_RUNTIME_PORT}/api`;
  const desktopBase = `${window.location.protocol}//${window.location.hostname}:${DESKTOP_RUNTIME_PORT}/api`;

  return Array.from(new Set([primary, webBase, desktopBase]));
}
