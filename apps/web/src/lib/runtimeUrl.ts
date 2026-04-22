import {
  getConfiguredWebDevPort,
  getConfiguredWebRuntimePort,
  type RuntimeConfigViteEnv,
} from "../../runtimeConfig";

declare global {
  interface Window {
    __CS_RUNTIME_API_BASE?: string;
    __CS_RUNTIME_PORT?: number;
    __TAURI_INTERNALS__?: unknown;
  }
}

function isDesktopRuntimeWindow(windowRef: Window): boolean {
  if (windowRef.__TAURI_INTERNALS__) return true;
  // Tauri production can use a non-http(s) protocol (e.g. "tauri:").
  return windowRef.location.protocol !== "http:" && windowRef.location.protocol !== "https:";
}

function getInjectedDesktopRuntimePort(windowRef: Window): number | null {
  const port = windowRef.__CS_RUNTIME_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    return null;
  }

  return port;
}

function getInjectedDesktopRuntimeApiBase(windowRef: Window): string | null {
  const apiBase = windowRef.__CS_RUNTIME_API_BASE;
  if (typeof apiBase !== "string" || apiBase.length === 0) {
    return null;
  }

  return apiBase;
}

function getViteEnv(): RuntimeConfigViteEnv {
  const meta = import.meta as ImportMeta & {
    env?: RuntimeConfigViteEnv;
  };

  return meta.env ?? {};
}

function looksLikeViteDevPort(port: string): boolean {
  const parsed = Number(port);
  return Number.isInteger(parsed) && parsed >= 5173 && parsed < 5300;
}

function isWebDevServerWindow(
  windowRef: Window,
  viteEnv: RuntimeConfigViteEnv,
): boolean {
  if (
    windowRef.location.port === getConfiguredWebDevPort(viteEnv)
    || looksLikeViteDevPort(windowRef.location.port)
  ) {
    return true;
  }

  return viteEnv.DEV === true
    && windowRef.location.port !== String(getConfiguredWebRuntimePort(viteEnv));
}

function toHostRuntimeApiBase(windowRef: Window, runtimePort: number): string {
  return `${windowRef.location.protocol}//${windowRef.location.hostname}:${runtimePort}/api`;
}

export function resolveRuntimeApiBase(): string {
  const viteEnv = getViteEnv();
  if (viteEnv.VITE_RUNTIME_URL) return viteEnv.VITE_RUNTIME_URL;
  if (typeof window === "undefined") {
    return `http://127.0.0.1:${getConfiguredWebRuntimePort(viteEnv)}/api`;
  }
  const injectedDesktopRuntimeApiBase = getInjectedDesktopRuntimeApiBase(window);
  if (injectedDesktopRuntimeApiBase) return injectedDesktopRuntimeApiBase;
  const injectedDesktopRuntimePort = getInjectedDesktopRuntimePort(window);
  if (isDesktopRuntimeWindow(window) && injectedDesktopRuntimePort != null) {
    return `http://127.0.0.1:${injectedDesktopRuntimePort}/api`;
  }

  // Desktop must trust the shell-injected runtime base instead of guessing fixed ports.
  // Web dev is the only mode where the frontend should infer a runtime port on its own.
  if (isWebDevServerWindow(window, viteEnv)) {
    return toHostRuntimeApiBase(window, getConfiguredWebRuntimePort(viteEnv));
  }

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

  if (
    getInjectedDesktopRuntimeApiBase(window)
    || getInjectedDesktopRuntimePort(window) != null
    || isDesktopRuntimeWindow(window)
  ) {
    return [primary];
  }

  if (!isWebDevServerWindow(window, viteEnv)) {
    return [primary];
  }

  const webBase = toHostRuntimeApiBase(window, getConfiguredWebRuntimePort(viteEnv));

  return Array.from(new Set([primary, webBase]));
}
