import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { useSearch } from "@tanstack/react-router";
import { useWorkspaceStartupState } from "../components/startup/workspaceStartupState";
import {
  emitStartupSnapshotReadMetric,
  finalizeStartupBlankScreenMetric,
  measureStartupMetricSinceBoot,
} from "../lib/startupPerf";
import { resolveStartupWorkspaceSelection } from "../lib/startupShellSnapshot";
import {
  getStartupBootReadySnapshot,
  subscribeStartupBootReady,
} from "../lib/startupBoot";
import { WorkspacePageShellFallback } from "./WorkspacePageShellFallback";
import {
  hasStartupThreadShellReadyState,
  hasStartupWorkspaceShellReadyState,
} from "./workspace/startupShellReadiness";
import {
  preloadRequestedWorkspaceStartupView,
  resolveRequestedWorkspaceStartupView,
} from "./workspace/startupSurfacePreload";

const loadWorkspacePageContent = () => import("./WorkspacePageContent");
const WorkspacePageContent = lazy(() =>
  loadWorkspacePageContent().then((module) => ({ default: module.WorkspacePage }))
);

if (typeof window !== "undefined") {
  void loadWorkspacePageContent().catch(() => {});

  preloadRequestedWorkspaceStartupView(
    resolveRequestedWorkspaceStartupView(window.location.search),
    {
      loadCodeEditorPanel: () => import("../components/workspace/CodeEditorPanel"),
      loadDiffReviewPanel: () => import("../components/workspace/DiffReviewPanel"),
      loadWorkspaceAutomationsPanel: () => import("./automations/AutomationsPage"),
    },
  );
}

export function WorkspacePage() {
  const search = useSearch({ from: "/" });
  const startupState = useWorkspaceStartupState();
  const startupBootReady = useSyncExternalStore(
    subscribeStartupBootReady,
    getStartupBootReadySnapshot,
    () => true,
  );
  const startupSnapshot = startupState.snapshot;
  const startupSelection = resolveStartupWorkspaceSelection({
    repoId: search.repoId,
    worktreeId: search.worktreeId,
    threadId: search.threadId,
    snapshot: startupSnapshot,
  });
  const snapshotMatchesRequestedRoute = startupSnapshot != null
    && (search.repoId == null || search.repoId === startupSnapshot.repoId)
    && (search.worktreeId == null || search.worktreeId === startupSnapshot.worktreeId)
    && (search.threadId == null || search.threadId === startupSnapshot.threadId);

  useEffect(() => {
    if (!startupSnapshot) {
      return;
    }

    measureStartupMetricSinceBoot("startup.shell_visible_ms", {
      source: "WorkspacePageShellFallback",
      target: startupState.desktopShell ? "desktop" : "web",
      routeRepoId: search.repoId ?? null,
      routeWorktreeId: search.worktreeId ?? null,
      routeThreadId: search.threadId ?? null,
    });
    emitStartupSnapshotReadMetric({
      source: "WorkspacePageShellFallback",
    });
    finalizeStartupBlankScreenMetric({
      source: "WorkspacePageShellFallback",
      reason: "workspace-shell-visible",
    });

    if (
      snapshotMatchesRequestedRoute
      && hasStartupWorkspaceShellReadyState({
        repositoryId: startupSelection.repoId ?? null,
        repositoryName: startupSnapshot.repoName,
        worktreeId: startupSelection.worktreeId ?? null,
        worktreeBranch: startupSnapshot.worktreeBranch,
        worktreePath: startupSnapshot.worktreePath,
      })
    ) {
      measureStartupMetricSinceBoot("startup.selected_workspace_ready_ms", {
        source: "WorkspacePageShellFallback",
        repositoryId: startupSelection.repoId ?? null,
        worktreeId: startupSelection.worktreeId ?? null,
        usedSnapshotFallback: true,
      });
    }

    if (
      snapshotMatchesRequestedRoute
      && hasStartupThreadShellReadyState({
        threadId: startupSelection.threadId ?? null,
        threadTitle: startupSnapshot.threadTitle,
      })
    ) {
      measureStartupMetricSinceBoot("startup.selected_thread_shell_ready_ms", {
        source: "WorkspacePageShellFallback",
        threadId: startupSelection.threadId ?? null,
        worktreeId: startupSelection.worktreeId ?? null,
        title: startupSnapshot.threadTitle ?? "Chat",
        usedSnapshotFallback: true,
      });
    }
  }, [
    search.repoId,
    search.threadId,
    search.worktreeId,
    snapshotMatchesRequestedRoute,
    startupSelection.repoId,
    startupSelection.threadId,
    startupSelection.worktreeId,
    startupSnapshot,
    startupState.desktopShell,
  ]);

  if (!startupBootReady) {
    return (
      <WorkspacePageShellFallback
        activeView={search.view ?? "chat"}
        filePath={search.file}
        panel={search.panel}
        runtimeState={startupState.runtimeState}
        snapshot={startupSnapshot}
      />
    );
  }

  return (
    <Suspense
      fallback={(
        <WorkspacePageShellFallback
          activeView={search.view ?? "chat"}
          filePath={search.file}
          panel={search.panel}
          runtimeState={startupState.runtimeState}
          snapshot={startupSnapshot}
        />
      )}
    >
      <WorkspacePageContent />
    </Suspense>
  );
}
