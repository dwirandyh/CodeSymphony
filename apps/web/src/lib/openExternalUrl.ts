import { logService } from "./logService";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

const DEFAULT_BROWSER_FEATURES = "noopener,noreferrer";
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function parseUrl(href: string): URL | null {
  try {
    const baseHref = typeof window === "undefined" ? "http://localhost" : window.location.href;
    return new URL(href, baseHref);
  } catch {
    return null;
  }
}

export function isTauriDesktop(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return typeof (window as TauriWindow).__TAURI_INTERNALS__ !== "undefined";
}

export function shouldOpenInExternalApp(href: string): boolean {
  const url = parseUrl(href);
  if (!url || !EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return false;
  }

  if (url.protocol === "mailto:" || url.protocol === "tel:") {
    return true;
  }

  if (typeof window === "undefined") {
    return true;
  }

  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    return url.origin !== window.location.origin;
  }

  return true;
}

export async function openExternalUrl(href: string): Promise<void> {
  const environment = isTauriDesktop() ? "tauri" : "browser";
  logService.log("info", "external-link", "Opening external URL", { href, environment });

  try {
    if (environment === "tauri") {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(href);
    } else {
      window.open(href, "_blank", DEFAULT_BROWSER_FEATURES);
    }

    logService.log("info", "external-link", "Opened external URL", { href, environment });
  } catch (error) {
    logService.log("error", "external-link", "Failed to open external URL", {
      href,
      environment,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
