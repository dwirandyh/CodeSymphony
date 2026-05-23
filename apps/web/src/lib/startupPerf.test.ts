import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupMetricId } from "./startupPerf";

const debugLogMock = vi.fn();

vi.mock("./debugLog", () => ({
  debugLog: (...args: unknown[]) => debugLogMock(...args),
}));

describe("startupPerf", () => {
  let perfNow = 0;

  beforeEach(() => {
    vi.resetModules();
    debugLogMock.mockReset();
    perfNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => perfNow);
    window.history.replaceState({}, "", "/");
    delete window.__CS_STARTUP_PERSISTED_STATE_OVERRIDE__;
    delete window.__CS_STARTUP_SCENARIO_OVERRIDE__;
    window.localStorage.removeItem("codesymphony.startupPerf.scenario");
    window.localStorage.removeItem("codesymphony.startupPerf.persistedState");
  });

  afterEach(async () => {
    const { resetStartupPerfForTest } = await import("./startupPerf");
    resetStartupPerfForTest();
    vi.restoreAllMocks();
    delete window.__CS_STARTUP_PERSISTED_STATE_OVERRIDE__;
    delete window.__CS_STARTUP_SCENARIO_OVERRIDE__;
    window.localStorage.removeItem("codesymphony.startupPerf.scenario");
    window.localStorage.removeItem("codesymphony.startupPerf.persistedState");
  });

  async function loadModule() {
    return import("./startupPerf");
  }

  async function getMetricPayload(metricId: StartupMetricId) {
    const call = debugLogMock.mock.calls.find(([, message]) => message === metricId);
    return call?.[2] as { value: number; data: Record<string, unknown> | null } | undefined;
  }

  it("emits startup metrics once with session metadata", async () => {
    const { initializeStartupPerfSession, measureStartupMetricSinceBoot } = await loadModule();

    initializeStartupPerfSession({ target: "web" });
    perfNow = 42.6;
    measureStartupMetricSinceBoot("startup.shell_visible_ms", { phase: "test" });
    perfNow = 100;
    measureStartupMetricSinceBoot("startup.shell_visible_ms", { phase: "ignored" });

    expect(debugLogMock).toHaveBeenCalledTimes(2);
    expect(debugLogMock).toHaveBeenNthCalledWith(
      1,
      "startup.perf",
      "startup.session.started",
      expect.objectContaining({
        target: "web",
        scenario: "unknown",
        persistedStateExpected: false,
        schemaVersion: 1,
      }),
      { force: true },
    );
    expect(debugLogMock).toHaveBeenNthCalledWith(
      2,
      "startup.perf",
      "startup.shell_visible_ms",
      expect.objectContaining({
        metricId: "startup.shell_visible_ms",
        unit: "ms",
        value: 42.6,
        target: "web",
        scenario: "unknown",
        persistedStateExpected: false,
        data: { phase: "test" },
      }),
      { force: true },
    );
  });

  it("tracks persisted snapshot reads and emits accumulated duration", async () => {
    const { initializeStartupPerfSession, trackStartupPersistedRead, emitStartupSnapshotReadMetric } = await loadModule();

    initializeStartupPerfSession({ target: "desktop" });

    trackStartupPersistedRead("workspace.search", () => {
      perfNow = 4.2;
      return null;
    });

    perfNow = 10;
    trackStartupPersistedRead("workspace.localStorage", () => {
      perfNow = 22.5;
      return "ok";
    });

    emitStartupSnapshotReadMetric({ source: "test" });

    const payload = await getMetricPayload("startup.snapshot_read_ms");
    expect(payload).toEqual(expect.objectContaining({
      value: 16.7,
      data: {
        operations: ["workspace.search", "workspace.localStorage"],
        source: "test",
      },
    }));
  });

  it("accumulates startup payload bytes until finalized", async () => {
    const { initializeStartupPerfSession, trackStartupBootstrapPayload, finalizeStartupBootstrapPayloadMetric } = await loadModule();

    initializeStartupPerfSession({ target: "web" });
    trackStartupBootstrapPayload("/repositories", 1200.2);
    trackStartupBootstrapPayload("/threads/thread-1/timeline", 3456);
    finalizeStartupBootstrapPayloadMetric({ source: "test" });

    const payload = await getMetricPayload("startup.bootstrap_payload_bytes");
    expect(payload).toEqual(expect.objectContaining({
      value: 4656,
      data: {
        requests: [
          { path: "/repositories", bytes: 1200 },
          { path: "/threads/thread-1/timeline", bytes: 3456 },
        ],
        source: "test",
      },
    }));
  });

  it("accumulates blank screen time only when persisted state is expected", async () => {
    window.history.replaceState({}, "", "/?startupPersistedState=1&startupScenario=warm-persisted");
    const { initializeStartupPerfSession, finalizeStartupBlankScreenMetric, setStartupBlankScreenVisible } = await loadModule();

    initializeStartupPerfSession({ target: "desktop" });

    setStartupBlankScreenVisible(true);
    perfNow = 18;
    setStartupBlankScreenVisible(false);
    perfNow = 25;
    setStartupBlankScreenVisible(true);
    perfNow = 40.3;
    finalizeStartupBlankScreenMetric({ reason: "shell-visible" });

    const payload = await getMetricPayload("startup.blank_screen_ms");
    expect(payload).toEqual(expect.objectContaining({
      value: 33.3,
      data: { reason: "shell-visible" },
    }));
  });

  it("reads scenario from storage when query params are absent", async () => {
    window.localStorage.setItem("codesymphony.startupPerf.scenario", "warm-runtime-delayed");
    window.localStorage.setItem("codesymphony.startupPerf.persistedState", "true");
    const { initializeStartupPerfSession, getStartupPerfSessionForTest } = await loadModule();

    initializeStartupPerfSession({ target: "desktop" });

    expect(getStartupPerfSessionForTest()).toEqual(expect.objectContaining({
      scenario: "warm-runtime-delayed",
      persistedStateExpected: true,
      target: "desktop",
    }));
  });

  it("prefers desktop startup overrides over storage state", async () => {
    window.__CS_STARTUP_SCENARIO_OVERRIDE__ = "cold-empty";
    window.__CS_STARTUP_PERSISTED_STATE_OVERRIDE__ = false;
    window.localStorage.setItem("codesymphony.startupPerf.scenario", "warm-runtime-delayed");
    window.localStorage.setItem("codesymphony.startupPerf.persistedState", "true");
    const { initializeStartupPerfSession, getStartupPerfSessionForTest } = await loadModule();

    initializeStartupPerfSession({ target: "desktop" });

    expect(getStartupPerfSessionForTest()).toEqual(expect.objectContaining({
      scenario: "cold-empty",
      persistedStateExpected: false,
      target: "desktop",
    }));
  });

  it("infers warm-persisted when a startup shell snapshot already exists", async () => {
    window.localStorage.setItem("codesymphony:workspace:startup-shell:v1", JSON.stringify({
      version: 1,
      capturedAt: "2026-05-19T00:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "worktree-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Instant open",
      threadStatus: "idle",
    }));
    const { initializeStartupPerfSession, getStartupPerfSessionForTest } = await loadModule();

    initializeStartupPerfSession({ target: "desktop" });

    expect(getStartupPerfSessionForTest()).toEqual(expect.objectContaining({
      scenario: "warm-persisted",
      persistedStateExpected: true,
      target: "desktop",
    }));
  });

  it("detects startup render profiling from query params", async () => {
    window.history.replaceState({}, "", "/?csProfileStartupRender=1");
    const { isStartupRenderProfileEnabled } = await loadModule();

    expect(isStartupRenderProfileEnabled()).toBe(true);
  });
});
