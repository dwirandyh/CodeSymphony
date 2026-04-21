export const DEFAULT_WEB_DEV_PORT = 5173;
export const DEFAULT_WEB_RUNTIME_PORT = 4331;

export type RuntimeConfigViteEnv = {
  DEV?: boolean;
  VITE_DEV_PORT?: string;
  VITE_RUNTIME_PORT?: string;
  VITE_RUNTIME_PROXY_TARGET?: string;
  VITE_RUNTIME_URL?: string;
};

function parseConfiguredPort(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function getConfiguredWebDevPort(viteEnv: Pick<RuntimeConfigViteEnv, "VITE_DEV_PORT">): string {
  return String(parseConfiguredPort(viteEnv.VITE_DEV_PORT) ?? DEFAULT_WEB_DEV_PORT);
}

export function getConfiguredWebRuntimePort(
  viteEnv: Pick<RuntimeConfigViteEnv, "VITE_RUNTIME_PORT">,
): number {
  return parseConfiguredPort(viteEnv.VITE_RUNTIME_PORT) ?? DEFAULT_WEB_RUNTIME_PORT;
}

export function getConfiguredRuntimeProxyTarget(
  viteEnv: Pick<RuntimeConfigViteEnv, "VITE_RUNTIME_PORT" | "VITE_RUNTIME_PROXY_TARGET">,
): string {
  return viteEnv.VITE_RUNTIME_PROXY_TARGET
    ?? `http://127.0.0.1:${getConfiguredWebRuntimePort(viteEnv)}`;
}
