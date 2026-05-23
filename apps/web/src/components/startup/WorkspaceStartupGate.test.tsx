import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyStartupRuntimeReady } from "../../lib/startupRuntimeReadySignal";
import { saveStartupShellSnapshot, STARTUP_SHELL_SNAPSHOT_STORAGE_KEY } from "../../lib/startupShellSnapshot";
import { WorkspaceStartupGate } from "./WorkspaceStartupGate";
import { useWorkspaceStartupState } from "./workspaceStartupState";

const isTauriDesktopMock = vi.fn();
const measureStartupMetricSinceBootMock = vi.fn();
const setStartupBlankScreenVisibleMock = vi.fn();

vi.mock("../../lib/openExternalUrl", () => ({
  isTauriDesktop: () => isTauriDesktopMock(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    runtimeBaseUrl: "http://127.0.0.1:4322",
  },
}));

vi.mock("../../lib/startupPerf", () => ({
  measureStartupMetricSinceBoot: (...args: unknown[]) => measureStartupMetricSinceBootMock(...args),
  setStartupBlankScreenVisible: (...args: unknown[]) => setStartupBlankScreenVisibleMock(...args),
}));

describe("WorkspaceStartupGate", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    act(() => {
      flushSync(() => {
        root.unmount();
      });
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
    window.localStorage.removeItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
  });

  function renderGate() {
    act(() => {
      flushSync(() => {
        root.render(
          <WorkspaceStartupGate>
            <div data-testid="workspace-ready">Workspace ready</div>
          </WorkspaceStartupGate>,
        );
      });
    });
  }

  function renderGateWithStartupStateProbe() {
    function StartupStateProbe() {
      const startupState = useWorkspaceStartupState();

      return (
        <div
          data-testid="startup-state-probe"
          data-desktop-shell={startupState.desktopShell ? "true" : "false"}
          data-has-persisted-shell={startupState.hasPersistedShell ? "true" : "false"}
          data-runtime-state={startupState.runtimeState}
          data-snapshot-repo={startupState.snapshot?.repoName ?? ""}
        />
      );
    }

    act(() => {
      flushSync(() => {
        root.render(
          <WorkspaceStartupGate>
            <StartupStateProbe />
          </WorkspaceStartupGate>,
        );
      });
    });
  }

  function persistStartupShellSnapshot() {
    saveStartupShellSnapshot({
      version: 1,
      capturedAt: "2026-05-19T12:00:00.000Z",
      repoId: "repo-1",
      repoName: "Repo One",
      worktreeId: "wt-1",
      worktreeBranch: "main",
      worktreePath: "/tmp/repo",
      worktreeStatus: "active",
      threadId: "thread-1",
      threadTitle: "Fix startup",
      threadStatus: "idle",
    });
  }

  it("renders children immediately outside the desktop shell", () => {
    isTauriDesktopMock.mockReturnValue(false);

    renderGate();

    expect(container.querySelector("[data-testid='workspace-ready']")).not.toBeNull();
    expect(container.querySelector("[data-testid='startup-splash']")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setStartupBlankScreenVisibleMock).not.toHaveBeenCalled();
  });

  it("keeps the startup splash visible until the desktop runtime health check succeeds", async () => {
    isTauriDesktopMock.mockReturnValue(true);
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true } as Response);

    renderGate();

    expect(container.querySelector("[data-testid='startup-splash']")).not.toBeNull();
    expect(container.querySelector("[data-testid='workspace-ready']")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(container.querySelector("[data-testid='workspace-ready']")).not.toBeNull();
    expect(container.querySelector("[data-testid='startup-splash']")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("http://127.0.0.1:4322/health");
    expect(setStartupBlankScreenVisibleMock).toHaveBeenCalledWith(true);
    expect(setStartupBlankScreenVisibleMock).toHaveBeenCalledWith(false);
    expect(measureStartupMetricSinceBootMock).toHaveBeenCalledWith("startup.runtime_connected_ms", {
      source: "startup-gate.healthcheck",
    });
  });

  it("renders children immediately on desktop when a startup shell snapshot exists", async () => {
    isTauriDesktopMock.mockReturnValue(true);
    persistStartupShellSnapshot();
    fetchMock.mockResolvedValue({ ok: true } as Response);

    renderGate();

    expect(container.querySelector("[data-testid='workspace-ready']")).not.toBeNull();
    expect(container.querySelector("[data-testid='startup-splash']")).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setStartupBlankScreenVisibleMock).toHaveBeenCalledWith(false);
  });

  it("waits longer before marking persisted desktop shell as stale", async () => {
    isTauriDesktopMock.mockReturnValue(true);
    persistStartupShellSnapshot();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    renderGateWithStartupStateProbe();

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_100);
    });

    expect(container.querySelector("[data-testid='startup-state-probe']")?.getAttribute("data-runtime-state"))
      .toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(container.querySelector("[data-testid='startup-state-probe']")?.getAttribute("data-runtime-state"))
      .toBe("stale");
  });

  it("treats a successful runtime signal as ready even before health probe succeeds", async () => {
    isTauriDesktopMock.mockReturnValue(true);
    persistStartupShellSnapshot();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    renderGateWithStartupStateProbe();

    act(() => {
      notifyStartupRuntimeReady("thread.timeline");
    });

    expect(container.querySelector("[data-testid='startup-state-probe']")?.getAttribute("data-runtime-state"))
      .toBe("ready");
    expect(measureStartupMetricSinceBootMock).toHaveBeenCalledWith("startup.runtime_connected_ms", {
      source: "startup-gate.runtime-signal",
    });
  });

  it("exposes persisted shell state on web while runtime reconnects", async () => {
    isTauriDesktopMock.mockReturnValue(false);
    persistStartupShellSnapshot();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    renderGateWithStartupStateProbe();

    expect(container.querySelector("[data-testid='startup-splash']")).toBeNull();

    const probe = container.querySelector("[data-testid='startup-state-probe']");
    expect(probe?.getAttribute("data-desktop-shell")).toBe("false");
    expect(probe?.getAttribute("data-has-persisted-shell")).toBe("true");
    expect(probe?.getAttribute("data-runtime-state")).toBe("restoring");
    expect(probe?.getAttribute("data-snapshot-repo")).toBe("Repo One");

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='startup-state-probe']")?.getAttribute("data-runtime-state")).toBe("reconnecting");
  });
});
