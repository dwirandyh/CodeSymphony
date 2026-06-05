import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { isDesktopShell } from "../../lib/openExternalUrl";
import {
  hasStartupShellSnapshot,
  loadStartupShellSnapshot,
} from "../../lib/startupShellSnapshot";
import {
  measureStartupMetricSinceBoot,
  setStartupBlankScreenVisible,
} from "../../lib/startupPerf";
import { subscribeStartupRuntimeReady } from "../../lib/startupRuntimeReadySignal";
import { StartupSplash } from "./StartupSplash";
import {
  WorkspaceStartupStateContext,
  type WorkspaceStartupRuntimeState,
} from "./workspaceStartupState";

const STARTUP_PROBE_INTERVAL_MS = 200;
const STARTUP_SLOW_THRESHOLD_MS = 4_000;
const STARTUP_STALE_THRESHOLD_MS = 8_000;
const STARTUP_TIMEOUT_MS = 30_000;

function getRuntimeHealthUrl() {
  return new URL("/health", api.runtimeBaseUrl).toString();
}

export function WorkspaceStartupGate({ children }: { children: ReactNode }) {
  const desktopShell = isDesktopShell();
  const [startupSnapshot] = useState(() => loadStartupShellSnapshot());
  const hasPersistedShell = hasStartupShellSnapshot(startupSnapshot);
  const [ready, setReady] = useState(() => !desktopShell || hasPersistedShell);
  const [runtimeConnected, setRuntimeConnected] = useState(() => !desktopShell && !hasPersistedShell);
  const [slow, setSlow] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [runtimeState, setRuntimeState] = useState<WorkspaceStartupRuntimeState>(() =>
    hasPersistedShell
      ? "restoring"
      : desktopShell
        ? "reconnecting"
        : "ready");
  const runtimeReadyHandledRef = useRef(false);

  const markRuntimeReady = useCallback((source: string) => {
    if (runtimeReadyHandledRef.current) {
      return;
    }

    runtimeReadyHandledRef.current = true;
    measureStartupMetricSinceBoot("startup.runtime_connected_ms", {
      source,
    });
    setRuntimeConnected(true);
    setReady(true);
    setSlow(false);
    setTimedOut(false);
    setRuntimeState("ready");
  }, []);

  useEffect(() => {
    if (!desktopShell || runtimeConnected) {
      return;
    }

    return subscribeStartupRuntimeReady(() => {
      markRuntimeReady("startup-gate.runtime-signal");
    });
  }, [desktopShell, markRuntimeReady, runtimeConnected]);

  useEffect(() => {
    if ((!desktopShell && !hasPersistedShell) || runtimeConnected) {
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const healthUrl = getRuntimeHealthUrl();

    const slowTimer = setTimeout(() => {
      if (!cancelled) {
        setSlow(true);
      }
    }, STARTUP_SLOW_THRESHOLD_MS);

    const staleTimer = hasPersistedShell
      ? setTimeout(() => {
        if (!cancelled) {
          setRuntimeState("stale");
        }
      }, STARTUP_STALE_THRESHOLD_MS)
      : null;

    const timeoutTimer = setTimeout(() => {
      if (!cancelled) {
        setSlow(true);
        setTimedOut(true);
        if (hasPersistedShell) {
          setRuntimeState("offline");
        }
      }
    }, STARTUP_TIMEOUT_MS);

    const probe = async () => {
      try {
        const response = await fetch(healthUrl, {
          cache: "no-store",
        });

        if (cancelled) {
          return;
        }

        if (response.ok) {
          markRuntimeReady("startup-gate.healthcheck");
          return;
        }
      } catch {
        // Retry until the managed desktop runtime becomes reachable.
      }

      if (cancelled) {
        return;
      }

      if (hasPersistedShell) {
        setRuntimeState((current) => current === "restoring" ? "reconnecting" : current);
      }

      retryTimer = setTimeout(() => {
        void probe();
      }, STARTUP_PROBE_INTERVAL_MS);
    };

    void probe();

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      if (staleTimer !== null) {
        clearTimeout(staleTimer);
      }
      clearTimeout(timeoutTimer);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
    };
  }, [desktopShell, hasPersistedShell, markRuntimeReady, runtimeConnected]);

  useEffect(() => {
    if (!desktopShell) {
      return;
    }

    setStartupBlankScreenVisible(!ready);

    return () => {
      setStartupBlankScreenVisible(false);
    };
  }, [desktopShell, ready]);

  const content = !ready ? (
    <StartupSplash
      headline={timedOut ? "Runtime Taking Longer Than Usual" : slow ? "Still Starting Your Workspace" : "Starting CodeSymphony"}
      detail={timedOut
        ? "The local runtime is still booting. If this keeps happening, fully quit and reopen CodeSymphony."
        : slow
          ? "Preparing the local runtime and restoring your workspace state."
          : "Preparing the local runtime before loading your workspace."}
      pulse={!timedOut}
    />
  ) : (
    <>{children}</>
  );

  return (
    <WorkspaceStartupStateContext.Provider value={{
      desktopShell,
      hasPersistedShell,
      runtimeState,
      snapshot: startupSnapshot,
    }}
    >
      {content}
    </WorkspaceStartupStateContext.Provider>
  );
}
