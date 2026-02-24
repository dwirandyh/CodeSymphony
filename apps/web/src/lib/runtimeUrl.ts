declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function resolveRuntimeApiBase(): string {
  if (import.meta.env.VITE_RUNTIME_URL) return import.meta.env.VITE_RUNTIME_URL;
  if (typeof window === "undefined") return "http://127.0.0.1:4321/api";
  // In Tauri production, window.location.protocol is "tauri:" which breaks URL construction
  if (window.__TAURI_INTERNALS__) return "http://127.0.0.1:4321/api";
  return `${window.location.protocol}//${window.location.hostname}:4321/api`;
}
