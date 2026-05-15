import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { isTauriDesktop } from "../../lib/openExternalUrl";
import { StartupSplash } from "./StartupSplash";

const STARTUP_PROBE_INTERVAL_MS = 200;
const STARTUP_SLOW_THRESHOLD_MS = 4_000;
const STARTUP_TIMEOUT_MS = 30_000;

function getRuntimeHealthUrl() {
  return new URL("/health", api.runtimeBaseUrl).toString();
}

export function WorkspaceStartupGate({ children }: { children: ReactNode }) {
  const desktopShell = isTauriDesktop();
  const [ready, setReady] = useState(() => !desktopShell);
  const [slow, setSlow] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!desktopShell || ready) {
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

    const timeoutTimer = setTimeout(() => {
      if (!cancelled) {
        setSlow(true);
        setTimedOut(true);
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
          setReady(true);
          setSlow(false);
          setTimedOut(false);
          return;
        }
      } catch {
        // Retry until the managed desktop runtime becomes reachable.
      }

      if (cancelled) {
        return;
      }

      retryTimer = setTimeout(() => {
        void probe();
      }, STARTUP_PROBE_INTERVAL_MS);
    };

    void probe();

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      clearTimeout(timeoutTimer);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
    };
  }, [desktopShell, ready]);

  if (!ready) {
    return (
      <StartupSplash
        headline={timedOut ? "Runtime Taking Longer Than Usual" : slow ? "Still Starting Your Workspace" : "Starting CodeSymphony"}
        detail={timedOut
          ? "The local runtime is still booting. If this keeps happening, fully quit and reopen CodeSymphony."
          : slow
            ? "Preparing the local runtime and restoring your workspace state."
            : "Preparing the local runtime before loading your workspace."}
        pulse={!timedOut}
      />
    );
  }

  return <>{children}</>;
}
