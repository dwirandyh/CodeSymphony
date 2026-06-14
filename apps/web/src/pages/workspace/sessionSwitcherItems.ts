import type { GlobalSessionTarget } from "./globalSessionTargets";

export type SessionSwitcherItemKind = "thread" | "terminal" | "review" | "file";

export type SessionSwitcherItem = {
  key: string;
  kind: SessionSwitcherItemKind;
  label: string;
  sublabel: string;
  /** Branch/worktree badge shown when the target lives in a different worktree. */
  contextLabel?: string;
};

type GlobalSwitcherSources = {
  selectedWorktreeId: string | null;
  worktrees: Array<{
    worktreeId: string;
    branch: string;
    threads: Array<{ id: string; title: string }>;
    terminalTabs: Array<{ id: string; title: string }>;
  }>;
};

function fileBasename(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

function fileDirectory(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";
}

function targetKey(target: GlobalSessionTarget): string {
  if (target.kind === "review") {
    return `review:${target.worktreeId}`;
  }
  if (target.kind === "file") {
    return `file:${target.worktreeId}:${target.path}`;
  }
  return `${target.kind}:${target.worktreeId}:${target.id}`;
}

export function buildGlobalSwitcherItems(
  targets: GlobalSessionTarget[],
  sources: GlobalSwitcherSources,
): SessionSwitcherItem[] {
  return targets.map((target) => {
    const group = sources.worktrees.find((candidate) => candidate.worktreeId === target.worktreeId);
    const contextLabel = group?.branch ?? undefined;
    const key = targetKey(target);

    if (target.kind === "thread") {
      const thread = group?.threads.find((candidate) => candidate.id === target.id);
      const title = thread?.title?.trim();
      return {
        key,
        kind: "thread",
        label: title && title.length > 0 ? title : "Untitled thread",
        sublabel: "",
        contextLabel,
      };
    }

    if (target.kind === "terminal") {
      const terminal = group?.terminalTabs.find((candidate) => candidate.id === target.id);
      const title = terminal?.title?.trim();
      return {
        key,
        kind: "terminal",
        label: title && title.length > 0 ? title : "Terminal",
        sublabel: "",
        contextLabel,
      };
    }

    if (target.kind === "review") {
      return { key, kind: "review", label: "Review", sublabel: "", contextLabel };
    }

    return {
      key,
      kind: "file",
      label: fileBasename(target.path),
      sublabel: fileDirectory(target.path),
      contextLabel,
    };
  });
}
