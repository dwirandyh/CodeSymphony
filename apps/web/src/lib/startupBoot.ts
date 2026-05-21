import type { QueryClient } from "@tanstack/react-query";
import { readWorkspaceShellStateSnapshot } from "../collections/workspaceShellState";
import { primeStartupShellSnapshot } from "./startupShellSnapshot";
import { startWorkspaceStartupBootstrap } from "./workspaceStartupBootstrap";
import { initializeWorkspacePersistence } from "./workspacePersistence";

type StartupBootDependencies = {
  primeStartupShellSnapshot: typeof primeStartupShellSnapshot;
  initializeWorkspacePersistence: typeof initializeWorkspacePersistence;
  readWorkspaceShellStateSnapshot: typeof readWorkspaceShellStateSnapshot;
  startWorkspaceStartupBootstrap: typeof startWorkspaceStartupBootstrap;
};

const DEFAULT_STARTUP_BOOT_DEPENDENCIES: StartupBootDependencies = {
  primeStartupShellSnapshot,
  initializeWorkspacePersistence,
  readWorkspaceShellStateSnapshot,
  startWorkspaceStartupBootstrap,
};

let startupBootReady = false;
const startupBootReadyListeners = new Set<() => void>();

function notifyStartupBootReadyListeners() {
  startupBootReadyListeners.forEach((listener) => {
    listener();
  });
}

function setStartupBootReady(nextReady: boolean) {
  if (startupBootReady === nextReady) {
    return;
  }

  startupBootReady = nextReady;
  notifyStartupBootReadyListeners();
}

export function getStartupBootReadySnapshot() {
  return startupBootReady;
}

export function subscribeStartupBootReady(listener: () => void) {
  startupBootReadyListeners.add(listener);

  return () => {
    startupBootReadyListeners.delete(listener);
  };
}

export async function bootstrapWorkspaceStartup(
  queryClient: QueryClient,
  dependencies: StartupBootDependencies = DEFAULT_STARTUP_BOOT_DEPENDENCIES,
) {
  setStartupBootReady(false);
  dependencies.primeStartupShellSnapshot();

  try {
    await dependencies.initializeWorkspacePersistence();
  } catch {
    // Startup should continue even when the persisted workspace DB is unavailable.
  }

  dependencies.primeStartupShellSnapshot({
    readFallbackSnapshot: dependencies.readWorkspaceShellStateSnapshot,
  });

  void dependencies.startWorkspaceStartupBootstrap(queryClient).catch(() => {});
  setStartupBootReady(true);
}
