import { debugLog } from "./debugLog";
import {
  hasStartupShellSnapshot,
  loadStartupShellSnapshot,
} from "./startupShellSnapshot";

export const STARTUP_METRIC_SCHEMA = {
  "startup.shell_visible_ms": {
    unit: "ms",
    description: "Time from app boot to first workspace shell paint.",
  },
  "startup.snapshot_read_ms": {
    unit: "ms",
    description: "Time spent reading persisted startup state.",
  },
  "startup.selected_workspace_ready_ms": {
    unit: "ms",
    description: "Time until selected repository/worktree shell is usable.",
  },
  "startup.selected_thread_shell_ready_ms": {
    unit: "ms",
    description: "Time until selected thread shell is shown.",
  },
  "startup.selected_thread_timeline_ready_ms": {
    unit: "ms",
    description: "Time until selected thread timeline is rendered.",
  },
  "startup.runtime_connected_ms": {
    unit: "ms",
    description: "Time until runtime API is reachable.",
  },
  "startup.live_connected_ms": {
    unit: "ms",
    description: "Time until live workspace resources connect.",
  },
  "startup.blank_screen_ms": {
    unit: "ms",
    description: "Cumulative blank or splash time while persisted state is expected.",
  },
  "startup.bootstrap_payload_bytes": {
    unit: "bytes",
    description: "Payload size of startup bootstrap fetch path.",
  },
  "bundle.workspace_page_gzip_kb": {
    unit: "kb",
    description: "Gzip size of WorkspacePage bundle chunk.",
  },
} as const;

export type StartupMetricId = keyof typeof STARTUP_METRIC_SCHEMA;
export type StartupScenarioId = "cold-empty" | "warm-persisted" | "warm-runtime-delayed" | "unknown";
export type StartupTarget = "web" | "desktop" | "unknown";

const STARTUP_BOOT_MARK = "codesymphony.startup.boot";
const STARTUP_SCENARIO_STORAGE_KEY = "codesymphony.startupPerf.scenario";
const STARTUP_PERSISTED_STATE_STORAGE_KEY = "codesymphony.startupPerf.persistedState";

type StartupMetricPayload = {
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

type StartupPerfSessionState = {
  sessionId: string;
  bootAtMs: number;
  target: StartupTarget;
  scenario: StartupScenarioId;
  persistedStateExpected: boolean;
  emittedMetrics: Partial<Record<StartupMetricId, StartupMetricPayload>>;
  snapshotReadMs: number;
  snapshotReadOperations: string[];
  blankScreenAccumulatedMs: number;
  blankScreenVisibleSinceMs: number | null;
  bootstrapPayloadBytes: number;
  bootstrapPayloadRequests: Array<{ path: string; bytes: number }>;
};

declare global {
  interface Window {
    __CS_STARTUP_PERSISTED_STATE_OVERRIDE__?: boolean;
    __CS_STARTUP_SCENARIO_OVERRIDE__?: StartupScenarioId;
    __CS_STARTUP_PERF__?: StartupPerfSessionState;
  }
}

function roundMetricValue(value: number) {
  return Math.round(value * 10) / 10;
}

function getPerfNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function hasPersistedStartupShell() {
  if (typeof window === "undefined") {
    return false;
  }

  return hasStartupShellSnapshot(loadStartupShellSnapshot());
}

function readStartupScenarioOverride(): StartupScenarioId | null {
  if (typeof window === "undefined") {
    return null;
  }

  const value = window.__CS_STARTUP_SCENARIO_OVERRIDE__;
  if (
    value === "cold-empty"
    || value === "warm-persisted"
    || value === "warm-runtime-delayed"
  ) {
    return value;
  }

  return null;
}

function readPersistedStateOverride() {
  if (typeof window === "undefined") {
    return null;
  }

  return typeof window.__CS_STARTUP_PERSISTED_STATE_OVERRIDE__ === "boolean"
    ? window.__CS_STARTUP_PERSISTED_STATE_OVERRIDE__
    : null;
}

function readStartupBooleanQueryFlag(name: string): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const query = new URLSearchParams(window.location.search);
    const value = query.get(name)?.trim().toLowerCase();
    if (value === "1" || value === "true") {
      return true;
    }
    if (value === "0" || value === "false") {
      return false;
    }
  } catch {
    // Ignore query parsing failures.
  }

  return null;
}

function readStartupScenario(): StartupScenarioId {
  if (typeof window === "undefined") {
    return "unknown";
  }

  const override = readStartupScenarioOverride();
  if (override) {
    return override;
  }

  try {
    const query = new URLSearchParams(window.location.search);
    const value = query.get("startupScenario")?.trim();
    if (
      value === "cold-empty"
      || value === "warm-persisted"
      || value === "warm-runtime-delayed"
    ) {
      return value;
    }
  } catch {
    // Ignore query parsing failures.
  }

  try {
    const storedValue = window.localStorage.getItem(STARTUP_SCENARIO_STORAGE_KEY)?.trim();
    if (
      storedValue === "cold-empty"
      || storedValue === "warm-persisted"
      || storedValue === "warm-runtime-delayed"
    ) {
      return storedValue;
    }
  } catch {
    // Ignore storage failures.
  }

  if (hasPersistedStartupShell()) {
    return "warm-persisted";
  }

  return "unknown";
}

function readPersistedStateExpectation() {
  if (typeof window === "undefined") {
    return false;
  }

  const override = readPersistedStateOverride();
  if (override != null) {
    return override;
  }

  try {
    const query = new URLSearchParams(window.location.search);
    const value = query.get("startupPersistedState")?.trim().toLowerCase();
    if (value === "1" || value === "true") {
      return true;
    }
    if (value === "0" || value === "false") {
      return false;
    }
  } catch {
    // Ignore query parsing failures.
  }

  try {
    const storedValue = window.localStorage.getItem(STARTUP_PERSISTED_STATE_STORAGE_KEY)?.trim().toLowerCase();
    if (storedValue === "1" || storedValue === "true") {
      return true;
    }
    if (storedValue === "0" || storedValue === "false") {
      return false;
    }
  } catch {
    return hasPersistedStartupShell();
  }

  return hasPersistedStartupShell();
}

export function isStartupRenderProfileEnabled() {
  return readStartupBooleanQueryFlag("csProfileStartupRender") === true;
}

function createSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `startup:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function ensureBootMark() {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") {
    return;
  }

  const existingMarks = typeof performance.getEntriesByName === "function"
    ? performance.getEntriesByName(STARTUP_BOOT_MARK, "mark")
    : [];
  if (existingMarks.length === 0) {
    performance.mark(STARTUP_BOOT_MARK);
  }
}

function getSession() {
  if (typeof window === "undefined") {
    return null;
  }

  if (!window.__CS_STARTUP_PERF__) {
    initializeStartupPerfSession();
  }

  return window.__CS_STARTUP_PERF__ ?? null;
}

function emitMetric(metricId: StartupMetricId, value: number, data?: Record<string, unknown>) {
  const session = getSession();
  if (!session || session.emittedMetrics[metricId]) {
    return null;
  }

  const schema = STARTUP_METRIC_SCHEMA[metricId];
  const payload: StartupMetricPayload = {
    metricId,
    unit: schema.unit,
    value: roundMetricValue(value),
    sessionId: session.sessionId,
    target: session.target,
    scenario: session.scenario,
    persistedStateExpected: session.persistedStateExpected,
    emittedAtMs: roundMetricValue(getPerfNow() - session.bootAtMs),
    data: data ?? null,
  };

  session.emittedMetrics[metricId] = payload;

  debugLog("startup.perf", metricId, payload, { force: true });

  return payload;
}

export function initializeStartupPerfSession(options?: { target?: StartupTarget }) {
  if (typeof window === "undefined") {
    return null;
  }

  if (window.__CS_STARTUP_PERF__) {
    if (options?.target && window.__CS_STARTUP_PERF__.target === "unknown") {
      window.__CS_STARTUP_PERF__.target = options.target;
    }
    return window.__CS_STARTUP_PERF__;
  }

  ensureBootMark();

  const session: StartupPerfSessionState = {
    sessionId: createSessionId(),
    bootAtMs: getPerfNow(),
    target: options?.target ?? "unknown",
    scenario: readStartupScenario(),
    persistedStateExpected: readPersistedStateExpectation(),
    emittedMetrics: {},
    snapshotReadMs: 0,
    snapshotReadOperations: [],
    blankScreenAccumulatedMs: 0,
    blankScreenVisibleSinceMs: null,
    bootstrapPayloadBytes: 0,
    bootstrapPayloadRequests: [],
  };
  window.__CS_STARTUP_PERF__ = session;

  debugLog("startup.perf", "startup.session.started", {
    sessionId: session.sessionId,
    target: session.target,
    scenario: session.scenario,
    persistedStateExpected: session.persistedStateExpected,
    schemaVersion: 1,
  }, { force: true });

  return session;
}

export function measureStartupMetricSinceBoot(metricId: StartupMetricId, data?: Record<string, unknown>) {
  const session = getSession();
  if (!session || session.emittedMetrics[metricId]) {
    return null;
  }

  const durationMs = getPerfNow() - session.bootAtMs;

  if (
    typeof performance !== "undefined"
    && typeof performance.mark === "function"
    && typeof performance.measure === "function"
  ) {
    const endMark = `codesymphony.startup.metric.${metricId}`;
    performance.mark(endMark);
    performance.measure(metricId, STARTUP_BOOT_MARK, endMark);
    if (typeof performance.clearMarks === "function") {
      performance.clearMarks(endMark);
    }
    if (typeof performance.clearMeasures === "function") {
      performance.clearMeasures(metricId);
    }
    return emitMetric(metricId, durationMs, data);
  }

  return emitMetric(metricId, getPerfNow() - session.bootAtMs, data);
}

export function emitStartupMetricValue(
  metricId: StartupMetricId,
  value: number,
  data?: Record<string, unknown>,
) {
  return emitMetric(metricId, value, data);
}

export function trackStartupPersistedRead<T>(operation: string, reader: () => T): T {
  const session = getSession();
  if (!session) {
    return reader();
  }

  const startedAtMs = getPerfNow();
  try {
    return reader();
  } finally {
    session.snapshotReadMs += Math.max(0, getPerfNow() - startedAtMs);
    session.snapshotReadOperations.push(operation);
  }
}

export function emitStartupSnapshotReadMetric(data?: Record<string, unknown>) {
  const session = getSession();
  if (!session) {
    return null;
  }

  return emitMetric("startup.snapshot_read_ms", session.snapshotReadMs, {
    operations: [...session.snapshotReadOperations],
    ...data,
  });
}

export function setStartupBlankScreenVisible(visible: boolean) {
  const session = getSession();
  if (!session || !session.persistedStateExpected) {
    return;
  }

  if (visible) {
    if (session.blankScreenVisibleSinceMs == null) {
      session.blankScreenVisibleSinceMs = getPerfNow();
    }
    return;
  }

  if (session.blankScreenVisibleSinceMs != null) {
    session.blankScreenAccumulatedMs += Math.max(0, getPerfNow() - session.blankScreenVisibleSinceMs);
    session.blankScreenVisibleSinceMs = null;
  }
}

export function finalizeStartupBlankScreenMetric(data?: Record<string, unknown>) {
  const session = getSession();
  if (!session) {
    return null;
  }

  setStartupBlankScreenVisible(false);
  return emitMetric("startup.blank_screen_ms", session.blankScreenAccumulatedMs, data);
}

export function trackStartupBootstrapPayload(path: string, bytes: number) {
  const session = getSession();
  if (
    !session
    || session.emittedMetrics["startup.bootstrap_payload_bytes"]
    || !Number.isFinite(bytes)
    || bytes <= 0
  ) {
    return;
  }

  const roundedBytes = Math.round(bytes);
  session.bootstrapPayloadBytes += roundedBytes;
  session.bootstrapPayloadRequests.push({ path, bytes: roundedBytes });
}

export function finalizeStartupBootstrapPayloadMetric(data?: Record<string, unknown>) {
  const session = getSession();
  if (!session) {
    return null;
  }

  return emitMetric("startup.bootstrap_payload_bytes", session.bootstrapPayloadBytes, {
    requests: [...session.bootstrapPayloadRequests],
    ...data,
  });
}

export function getStartupPerfSessionForTest() {
  return getSession();
}

export function resetStartupPerfForTest() {
  if (typeof window === "undefined") {
    return;
  }

  delete window.__CS_STARTUP_PERF__;
  if (typeof performance !== "undefined") {
    if (typeof performance.clearMarks === "function") {
      performance.clearMarks();
    }
    if (typeof performance.clearMeasures === "function") {
      performance.clearMeasures();
    }
  }
}
