import { afterEach, describe, expect, it } from "vitest";
import { installDesktopShellVitePreloadGuard } from "./vitePreloadGuard";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

describe("installDesktopShellVitePreloadGuard", () => {
  const cleanups: Array<() => void> = [];
  const originalTauriInternals = window.__TAURI_INTERNALS__;

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }

    if (typeof originalTauriInternals === "undefined") {
      delete window.__TAURI_INTERNALS__;
    } else {
      window.__TAURI_INTERNALS__ = originalTauriInternals;
    }
  });

  it("suppresses desktop shell CSS preload errors", () => {
    window.__TAURI_INTERNALS__ = {};

    const cleanup = installDesktopShellVitePreloadGuard(window);
    expect(cleanup).not.toBeNull();
    if (cleanup) {
      cleanups.push(cleanup);
    }

    const event = new Event("vite:preloadError", { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error("Unable to preload CSS for /assets/TerminalTab.css");

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves browser preload errors untouched", () => {
    delete window.__TAURI_INTERNALS__;

    const cleanup = installDesktopShellVitePreloadGuard(window);
    expect(cleanup).toBeNull();

    const event = new Event("vite:preloadError", { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error("Unable to preload CSS for /assets/TerminalTab.css");

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("does not swallow unrelated desktop shell preload failures", () => {
    window.__TAURI_INTERNALS__ = {};

    const cleanup = installDesktopShellVitePreloadGuard(window);
    expect(cleanup).not.toBeNull();
    if (cleanup) {
      cleanups.push(cleanup);
    }

    const event = new Event("vite:preloadError", { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error("Failed to fetch dynamically imported module");

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
