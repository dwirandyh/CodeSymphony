import { isTauriDesktop } from "./openExternalUrl";

export interface DesktopResourceUsage {
  cpu: number;
  memory: number;
}

export interface DesktopResourceMonitorSnapshot {
  shell: DesktopResourceUsage;
  webview: DesktopResourceUsage;
  runtime: DesktopResourceUsage;
  other: DesktopResourceUsage;
}

function normalizeUsage(value: unknown): DesktopResourceUsage {
  const candidate = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};

  const cpu = typeof candidate.cpu === "number" && Number.isFinite(candidate.cpu)
    ? Math.max(0, candidate.cpu)
    : 0;
  const memory = typeof candidate.memory === "number" && Number.isFinite(candidate.memory)
    ? Math.max(0, candidate.memory)
    : 0;

  return { cpu, memory };
}

export async function getDesktopResourceMonitorSnapshot(
  runtimePid: number | null | undefined,
): Promise<DesktopResourceMonitorSnapshot | null> {
  if (!isTauriDesktop()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<unknown>("collect_resource_monitor_desktop_metrics", {
    runtimePid: typeof runtimePid === "number" && Number.isInteger(runtimePid) && runtimePid > 0
      ? runtimePid
      : null,
  });
  const snapshot = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};

  return {
    shell: normalizeUsage(snapshot.shell),
    webview: normalizeUsage(snapshot.webview),
    runtime: normalizeUsage(snapshot.runtime),
    other: normalizeUsage(snapshot.other),
  };
}
