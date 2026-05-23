import os from "node:os";
import path from "node:path";

export type StartupMetricId =
  | "startup.shell_visible_ms"
  | "startup.snapshot_read_ms"
  | "startup.selected_workspace_ready_ms"
  | "startup.selected_thread_shell_ready_ms"
  | "startup.selected_thread_timeline_ready_ms"
  | "startup.runtime_connected_ms"
  | "startup.live_connected_ms"
  | "startup.blank_screen_ms"
  | "startup.bootstrap_payload_bytes"
  | "bundle.workspace_page_gzip_kb";

export type StartupScenarioId = "cold-empty" | "warm-persisted" | "warm-runtime-delayed" | "unknown";
export type StartupTarget = "web" | "desktop" | "unknown";

export type StartupMetricEntry = {
  metricId: StartupMetricId;
  unit: "ms" | "bytes" | "kb";
  value: number;
  sessionId: string;
  target: StartupTarget;
  scenario: StartupScenarioId;
  persistedStateExpected: boolean;
  emittedAtMs: number;
  data: Record<string, unknown> | null;
};

export type StartupSessionSummary = {
  sessionId: string;
  target: StartupTarget;
  scenario: StartupScenarioId;
  persistedStateExpected: boolean;
  startedAtMs: number | null;
  metrics: Partial<Record<StartupMetricId, StartupMetricEntry>>;
};

export const STARTUP_METRIC_ORDER: StartupMetricId[] = [
  "startup.shell_visible_ms",
  "startup.snapshot_read_ms",
  "startup.selected_workspace_ready_ms",
  "startup.selected_thread_shell_ready_ms",
  "startup.selected_thread_timeline_ready_ms",
  "startup.runtime_connected_ms",
  "startup.live_connected_ms",
  "startup.blank_screen_ms",
  "startup.bootstrap_payload_bytes",
  "bundle.workspace_page_gzip_kb",
];

export function resolveDebugLogPath(): string {
  const configuredPath = process.env.CODESYMPHONY_DEBUG_LOG_PATH?.trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.join(os.tmpdir(), "codesymphony", "debug.log");
}

export function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const targetIndex = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );

  return sorted[targetIndex] ?? 0;
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatMetricValue(value: number, unit: "ms" | "bytes" | "kb"): string {
  if (unit === "ms") {
    return `${round(value)} ms`;
  }

  if (unit === "kb") {
    return `${round(value)} kB`;
  }

  if (value >= 1024 * 1024) {
    return `${round(value / (1024 * 1024))} MB`;
  }

  if (value >= 1024) {
    return `${round(value / 1024)} kB`;
  }

  return `${Math.round(value)} B`;
}
