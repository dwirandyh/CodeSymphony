import type { ExternalApp } from "@codesymphony/shared-types";

const PREFERRED_APP_KEY_PREFIX = "codesymphony:preferred-editor";

export function getPreferredAppId(targetPath: string): string | null {
  try {
    const specific = localStorage.getItem(`${PREFERRED_APP_KEY_PREFIX}:${targetPath}`);
    if (specific) {
      return specific;
    }

    return localStorage.getItem(PREFERRED_APP_KEY_PREFIX);
  } catch {
    return null;
  }
}

export function setPreferredAppId(targetPath: string, appId: string) {
  try {
    localStorage.setItem(`${PREFERRED_APP_KEY_PREFIX}:${targetPath}`, appId);
    localStorage.setItem(PREFERRED_APP_KEY_PREFIX, appId);
  } catch {
    // localStorage not available
  }
}

export function resolvePreferredApp(apps: ExternalApp[], targetPath: string): ExternalApp | null {
  const preferredId = getPreferredAppId(targetPath);
  return apps.find((app) => app.id === preferredId) ?? apps[0] ?? null;
}
