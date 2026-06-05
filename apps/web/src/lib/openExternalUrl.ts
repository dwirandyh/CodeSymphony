import { logService } from "./logService";
import { getElectronBridge, isDesktopShell, isElectronDesktop } from "./desktopBridge";

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

export { isDesktopShell, isElectronDesktop };

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
  const environment = isElectronDesktop() ? "electron" : "browser";
  logService.log("info", "external-link", "Opening external URL", { href, environment });

  try {
    if (isDesktopShell()) {
      const opened = await getElectronBridge()?.openExternalUrl?.(href);
      if (typeof opened === "undefined" && !isElectronDesktop()) window.open(href, "_blank", DEFAULT_BROWSER_FEATURES);
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
