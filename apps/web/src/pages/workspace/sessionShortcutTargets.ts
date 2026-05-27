import type { ChatThread } from "@codesymphony/shared-types";
import type { WorkspaceTerminalTab } from "../../components/workspace/WorkspaceHeader";

export type SessionShortcutTarget =
  | { kind: "thread"; id: string }
  | { kind: "terminal"; id: string }
  | { kind: "review" }
  | { kind: "file"; path: string };

export function buildSessionShortcutTargets(input: {
  threads: ChatThread[];
  terminalTabs: WorkspaceTerminalTab[];
  reviewTabOpen: boolean;
  fileTabs: Array<{ path: string }>;
}): SessionShortcutTarget[] {
  return [
    ...input.threads.map((thread) => ({ kind: "thread" as const, id: thread.id })),
    ...input.terminalTabs.map((terminalTab) => ({ kind: "terminal" as const, id: terminalTab.id })),
    ...(input.reviewTabOpen ? [{ kind: "review" as const }] : []),
    ...input.fileTabs.map((fileTab) => ({ kind: "file" as const, path: fileTab.path })),
  ];
}

export function getActiveSessionShortcutTarget(
  targets: SessionShortcutTarget[],
  active: {
    activeView: "chat" | "file" | "review" | "automations";
    selectedThreadId: string | null;
    terminalViewActive: boolean;
    activeTerminalTabId: string | null;
    activeFilePath: string | null;
  },
): SessionShortcutTarget | null {
  return targets.find((target) => {
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

export function getActiveSessionShortcutTargetIndex(
  targets: SessionShortcutTarget[],
  active: {
    activeView: "chat" | "file" | "review" | "automations";
    selectedThreadId: string | null;
    terminalViewActive: boolean;
    activeTerminalTabId: string | null;
    activeFilePath: string | null;
  },
): number {
  const activeTarget = getActiveSessionShortcutTarget(targets, active);
  return activeTarget ? targets.findIndex((target) => sessionShortcutTargetsEqual(target, activeTarget)) : -1;
}

export function sessionShortcutTargetsEqual(a: SessionShortcutTarget, b: SessionShortcutTarget): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === "review") {
    return true;
  }

  if (a.kind === "file") {
    return a.path === (b as Extract<SessionShortcutTarget, { kind: "file" }>).path;
  }

  return a.id === (b as Extract<SessionShortcutTarget, { kind: "thread" | "terminal" }>).id;
}

export function normalizeSessionShortcutHistory(
  history: SessionShortcutTarget[],
  targets: SessionShortcutTarget[],
): SessionShortcutTarget[] {
  const normalized: SessionShortcutTarget[] = [];
  for (const item of history) {
    const target = targets.find((candidate) => sessionShortcutTargetsEqual(candidate, item));
    if (!target || normalized.some((candidate) => sessionShortcutTargetsEqual(candidate, target))) {
      continue;
    }
    normalized.push(target);
  }
  return normalized;
}

export function promoteSessionShortcutTarget(
  history: SessionShortcutTarget[],
  target: SessionShortcutTarget,
  targets: SessionShortcutTarget[],
): SessionShortcutTarget[] {
  return [
    target,
    ...normalizeSessionShortcutHistory(history, targets)
      .filter((item) => !sessionShortcutTargetsEqual(item, target)),
  ];
}

export function buildSessionShortcutCycleHistory(
  history: SessionShortcutTarget[],
  targets: SessionShortcutTarget[],
  activeTarget: SessionShortcutTarget | null,
): SessionShortcutTarget[] {
  const normalizedHistory = activeTarget
    ? promoteSessionShortcutTarget(history, activeTarget, targets)
    : normalizeSessionShortcutHistory(history, targets);
  return [
    ...normalizedHistory,
    ...targets.filter((target) => (
      !normalizedHistory.some((historyItem) => sessionShortcutTargetsEqual(historyItem, target))
    )),
  ];
}
