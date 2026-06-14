export type GlobalSessionTarget =
  | { kind: "thread"; repositoryId: string; worktreeId: string; id: string }
  | { kind: "terminal"; repositoryId: string; worktreeId: string; id: string }
  | { kind: "review"; repositoryId: string; worktreeId: string }
  | { kind: "file"; repositoryId: string; worktreeId: string; path: string };

type WorktreeSessionGroup = {
  repositoryId: string;
  worktreeId: string;
  threads: Array<{ id: string; tabOpen?: boolean }>;
  terminalTabs: Array<{ id: string }>;
};

export function buildGlobalSessionTargets(input: {
  worktrees: WorktreeSessionGroup[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  reviewTabOpen: boolean;
  fileTabs: Array<{ path: string }>;
}): GlobalSessionTarget[] {
  const targets: GlobalSessionTarget[] = [];

  for (const group of input.worktrees) {
    for (const thread of group.threads) {
      if ((thread.tabOpen ?? true) === false) {
        continue;
      }
      targets.push({
        kind: "thread",
        repositoryId: group.repositoryId,
        worktreeId: group.worktreeId,
        id: thread.id,
      });
    }

    for (const terminalTab of group.terminalTabs) {
      targets.push({
        kind: "terminal",
        repositoryId: group.repositoryId,
        worktreeId: group.worktreeId,
        id: terminalTab.id,
      });
    }

    // Review + file tabs are only meaningful for the currently selected worktree,
    // because they live in the selected worktree's editor surface.
    if (
      input.selectedRepositoryId === group.repositoryId
      && input.selectedWorktreeId === group.worktreeId
    ) {
      if (input.reviewTabOpen) {
        targets.push({
          kind: "review",
          repositoryId: group.repositoryId,
          worktreeId: group.worktreeId,
        });
      }
      for (const fileTab of input.fileTabs) {
        targets.push({
          kind: "file",
          repositoryId: group.repositoryId,
          worktreeId: group.worktreeId,
          path: fileTab.path,
        });
      }
    }
  }

  return targets;
}

export function globalSessionTargetsEqual(a: GlobalSessionTarget, b: GlobalSessionTarget): boolean {
  if (a.kind !== b.kind || a.repositoryId !== b.repositoryId || a.worktreeId !== b.worktreeId) {
    return false;
  }

  if (a.kind === "review") {
    return true;
  }

  if (a.kind === "file") {
    return a.path === (b as Extract<GlobalSessionTarget, { kind: "file" }>).path;
  }

  return a.id === (b as Extract<GlobalSessionTarget, { kind: "thread" | "terminal" }>).id;
}

export function getActiveGlobalSessionTarget(
  targets: GlobalSessionTarget[],
  active: {
    activeView: "chat" | "file" | "review" | "automations";
    selectedRepositoryId: string | null;
    selectedWorktreeId: string | null;
    selectedThreadId: string | null;
    terminalViewActive: boolean;
    activeTerminalTabId: string | null;
    activeFilePath: string | null;
  },
): GlobalSessionTarget | null {
  return targets.find((target) => {
    if (target.repositoryId !== active.selectedRepositoryId || target.worktreeId !== active.selectedWorktreeId) {
      return false;
    }

    if (target.kind === "thread") {
      return (
        active.activeView === "chat"
        && !active.terminalViewActive
        && target.id === active.selectedThreadId
      );
    }

    if (target.kind === "terminal") {
      return active.terminalViewActive && target.id === active.activeTerminalTabId;
    }

    if (target.kind === "review") {
      return active.activeView === "review";
    }

    return active.activeView === "file" && target.path === active.activeFilePath;
  }) ?? null;
}

export function getActiveGlobalSessionTargetIndex(
  targets: GlobalSessionTarget[],
  active: Parameters<typeof getActiveGlobalSessionTarget>[1],
): number {
  const activeTarget = getActiveGlobalSessionTarget(targets, active);
  return activeTarget ? targets.findIndex((target) => globalSessionTargetsEqual(target, activeTarget)) : -1;
}

export function normalizeGlobalSessionHistory(
  history: GlobalSessionTarget[],
  targets: GlobalSessionTarget[],
): GlobalSessionTarget[] {
  const normalized: GlobalSessionTarget[] = [];
  for (const item of history) {
    const target = targets.find((candidate) => globalSessionTargetsEqual(candidate, item));
    if (!target || normalized.some((candidate) => globalSessionTargetsEqual(candidate, target))) {
      continue;
    }
    normalized.push(target);
  }
  return normalized;
}

export function promoteGlobalSessionTarget(
  history: GlobalSessionTarget[],
  target: GlobalSessionTarget,
  targets: GlobalSessionTarget[],
): GlobalSessionTarget[] {
  return [
    target,
    ...normalizeGlobalSessionHistory(history, targets)
      .filter((item) => !globalSessionTargetsEqual(item, target)),
  ];
}

export function buildGlobalSessionCycleHistory(
  history: GlobalSessionTarget[],
  targets: GlobalSessionTarget[],
  activeTarget: GlobalSessionTarget | null,
): GlobalSessionTarget[] {
  const normalizedHistory = activeTarget
    ? promoteGlobalSessionTarget(history, activeTarget, targets)
    : normalizeGlobalSessionHistory(history, targets);
  return [
    ...normalizedHistory,
    ...targets.filter((target) => (
      !normalizedHistory.some((historyItem) => globalSessionTargetsEqual(historyItem, target))
    )),
  ];
}
