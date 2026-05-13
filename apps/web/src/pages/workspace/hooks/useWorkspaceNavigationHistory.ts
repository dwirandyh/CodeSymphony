import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { WorkspaceSearch } from "../../../routes/index";

const MAX_HISTORY_ENTRIES = 100;

type WorkspaceNavigationSnapshot = Pick<
  WorkspaceSearch,
  | "repoId"
  | "worktreeId"
  | "threadId"
  | "view"
  | "file"
  | "fileLine"
  | "fileColumn"
  | "automationId"
  | "automationCreate"
>;

type WorkspaceNavigationHistoryState = {
  backStack: WorkspaceNavigationSnapshot[];
  forwardStack: WorkspaceNavigationSnapshot[];
};

function normalizeWorkspaceNavigationSnapshot(search: WorkspaceSearch): WorkspaceNavigationSnapshot {
  const view = search.view === "file" || search.view === "review" || search.view === "automations" ? search.view : undefined;
  const file = view === "file" || view === "review" ? search.file ?? undefined : undefined;
  const normalizedView = view === "file" && !file ? undefined : view;
  const fileLine = normalizedView === "file" && file ? search.fileLine ?? undefined : undefined;
  const automationId = normalizedView === "automations" ? search.automationId ?? undefined : undefined;
  const automationCreate = normalizedView === "automations" && !automationId
    ? search.automationCreate || undefined
    : undefined;

  return {
    repoId: search.repoId ?? undefined,
    worktreeId: search.worktreeId ?? undefined,
    threadId: search.threadId ?? undefined,
    view: normalizedView,
    file,
    fileLine,
    fileColumn: normalizedView === "file" && file && fileLine ? search.fileColumn ?? undefined : undefined,
    automationId,
    automationCreate,
  };
}

function areWorkspaceNavigationSnapshotsEqual(
  left: WorkspaceNavigationSnapshot,
  right: WorkspaceNavigationSnapshot,
): boolean {
  return (
    left.repoId === right.repoId
    && left.worktreeId === right.worktreeId
    && left.threadId === right.threadId
    && left.view === right.view
    && left.file === right.file
    && left.fileLine === right.fileLine
    && left.fileColumn === right.fileColumn
    && left.automationId === right.automationId
    && left.automationCreate === right.automationCreate
  );
}

function isMeaningfulWorkspaceNavigationSnapshot(snapshot: WorkspaceNavigationSnapshot): boolean {
  return !!(
    snapshot.repoId
    || snapshot.worktreeId
    || snapshot.threadId
    || snapshot.view
    || snapshot.file
    || snapshot.automationId
    || snapshot.automationCreate
  );
}

function pushWorkspaceNavigationSnapshot(
  stack: WorkspaceNavigationSnapshot[],
  snapshot: WorkspaceNavigationSnapshot,
): WorkspaceNavigationSnapshot[] {
  if (!isMeaningfulWorkspaceNavigationSnapshot(snapshot)) {
    return stack;
  }

  const lastSnapshot = stack[stack.length - 1];
  if (lastSnapshot && areWorkspaceNavigationSnapshotsEqual(lastSnapshot, snapshot)) {
    return stack;
  }

  const nextStack = [...stack, snapshot];
  return nextStack.length > MAX_HISTORY_ENTRIES
    ? nextStack.slice(nextStack.length - MAX_HISTORY_ENTRIES)
    : nextStack;
}

type UseWorkspaceNavigationHistoryOptions = {
  search: WorkspaceSearch;
  updateSearch: (partial: Partial<WorkspaceSearch>) => void;
};

export function useWorkspaceNavigationHistory({
  search,
  updateSearch,
}: UseWorkspaceNavigationHistoryOptions) {
  const [historyState, setHistoryState] = useState<WorkspaceNavigationHistoryState>(() => ({
    backStack: [],
    forwardStack: [],
  }));
  const historyStateRef = useRef(historyState);
  const currentSnapshotRef = useRef<WorkspaceNavigationSnapshot | null>(null);
  const pendingTargetRef = useRef<WorkspaceNavigationSnapshot | null>(null);

  const setHistoryStateAndRef = useCallback((nextState: SetStateAction<WorkspaceNavigationHistoryState>) => {
    const resolvedState = typeof nextState === "function"
      ? nextState(historyStateRef.current)
      : nextState;
    historyStateRef.current = resolvedState;
    setHistoryState(resolvedState);
  }, []);

  const snapshot = useMemo(
    () => normalizeWorkspaceNavigationSnapshot(search),
    [
      search.automationCreate,
      search.automationId,
      search.file,
      search.fileColumn,
      search.fileLine,
      search.repoId,
      search.threadId,
      search.view,
      search.worktreeId,
    ],
  );

  useEffect(() => {
    const currentSnapshot = currentSnapshotRef.current;
    if (!currentSnapshot) {
      currentSnapshotRef.current = snapshot;
      return;
    }

    if (areWorkspaceNavigationSnapshotsEqual(currentSnapshot, snapshot)) {
      if (
        pendingTargetRef.current
        && areWorkspaceNavigationSnapshotsEqual(pendingTargetRef.current, snapshot)
      ) {
        pendingTargetRef.current = null;
      }
      return;
    }

    const pendingTarget = pendingTargetRef.current;
    if (pendingTarget && areWorkspaceNavigationSnapshotsEqual(pendingTarget, snapshot)) {
      currentSnapshotRef.current = snapshot;
      pendingTargetRef.current = null;
      return;
    }

    currentSnapshotRef.current = snapshot;
    pendingTargetRef.current = null;
    setHistoryStateAndRef((currentHistoryState) => {
      const nextBackStack = pushWorkspaceNavigationSnapshot(currentHistoryState.backStack, currentSnapshot);
      if (nextBackStack === currentHistoryState.backStack && currentHistoryState.forwardStack.length === 0) {
        return currentHistoryState;
      }

      return {
        backStack: nextBackStack,
        forwardStack: [],
      };
    });
  }, [setHistoryStateAndRef, snapshot]);

  const applySnapshot = useCallback((targetSnapshot: WorkspaceNavigationSnapshot) => {
    pendingTargetRef.current = targetSnapshot;
    updateSearch({
      repoId: targetSnapshot.repoId,
      worktreeId: targetSnapshot.worktreeId,
      threadId: targetSnapshot.threadId,
      view: targetSnapshot.view,
      file: targetSnapshot.file,
      fileLine: targetSnapshot.fileLine,
      fileColumn: targetSnapshot.fileColumn,
      automationId: targetSnapshot.automationId,
      automationCreate: targetSnapshot.automationCreate,
    });
  }, [updateSearch]);

  const goBack = useCallback(() => {
    if (pendingTargetRef.current) {
      return;
    }

    const currentSnapshot = currentSnapshotRef.current;
    const { backStack, forwardStack } = historyStateRef.current;
    const targetSnapshot = backStack[backStack.length - 1];
    if (!currentSnapshot || !targetSnapshot) {
      return;
    }

    setHistoryStateAndRef({
      backStack: backStack.slice(0, -1),
      forwardStack: pushWorkspaceNavigationSnapshot(forwardStack, currentSnapshot),
    });
    applySnapshot(targetSnapshot);
  }, [applySnapshot, setHistoryStateAndRef]);

  const goForward = useCallback(() => {
    if (pendingTargetRef.current) {
      return;
    }

    const currentSnapshot = currentSnapshotRef.current;
    const { backStack, forwardStack } = historyStateRef.current;
    const targetSnapshot = forwardStack[forwardStack.length - 1];
    if (!currentSnapshot || !targetSnapshot) {
      return;
    }

    setHistoryStateAndRef({
      backStack: pushWorkspaceNavigationSnapshot(backStack, currentSnapshot),
      forwardStack: forwardStack.slice(0, -1),
    });
    applySnapshot(targetSnapshot);
  }, [applySnapshot, setHistoryStateAndRef]);

  return {
    canGoBack: historyState.backStack.length > 0,
    canGoForward: historyState.forwardStack.length > 0,
    goBack,
    goForward,
  };
}
