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

export function resolveRuntimeApiBase(): string {
  if (import.meta.env.VITE_RUNTIME_URL) return import.meta.env.VITE_RUNTIME_URL;
  if (typeof window === "undefined") return "http://127.0.0.1:4321/api";
  if (isDesktopRuntimeWindow(window)) return "http://127.0.0.1:4321/api";
  return `${window.location.protocol}//${window.location.hostname}:4321/api`;
}
