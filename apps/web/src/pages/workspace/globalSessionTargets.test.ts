import { describe, expect, it } from "vitest";
import {
  buildGlobalSessionCycleHistory,
  buildGlobalSessionTargets,
  getActiveGlobalSessionTarget,
  globalSessionTargetsEqual,
  promoteGlobalSessionTarget,
  type GlobalSessionTarget,
} from "./globalSessionTargets";

const worktrees = [
  {
    repositoryId: "repoA",
    worktreeId: "wtA",
    threads: [
      { id: "a1", tabOpen: true },
      { id: "a2", tabOpen: false }, // closed -> excluded
    ],
    terminalTabs: [{ id: "termA1" }],
  },
  {
    repositoryId: "repoB",
    worktreeId: "wtB",
    threads: [{ id: "b1", tabOpen: true }],
    terminalTabs: [],
  },
];

function build(overrides?: Partial<Parameters<typeof buildGlobalSessionTargets>[0]>) {
  return buildGlobalSessionTargets({
    worktrees,
    selectedRepositoryId: "repoA",
    selectedWorktreeId: "wtA",
    reviewTabOpen: false,
    fileTabs: [],
    ...overrides,
  });
}

describe("buildGlobalSessionTargets", () => {
  it("includes open threads + terminals across every worktree", () => {
    const targets = build();
    expect(targets).toEqual([
      { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "a1" },
      { kind: "terminal", repositoryId: "repoA", worktreeId: "wtA", id: "termA1" },
      { kind: "thread", repositoryId: "repoB", worktreeId: "wtB", id: "b1" },
    ]);
  });

  it("excludes closed threads (tabOpen === false)", () => {
    const targets = build();
    expect(targets.some((target) => target.kind === "thread" && target.id === "a2")).toBe(false);
  });

  it("adds review + file targets only for the selected worktree", () => {
    const targets = build({
      reviewTabOpen: true,
      fileTabs: [{ path: "src/App.tsx" }],
    });
    const selectedExtras = targets.filter(
      (target) => target.kind === "review" || target.kind === "file",
    );
    expect(selectedExtras).toEqual([
      { kind: "review", repositoryId: "repoA", worktreeId: "wtA" },
      { kind: "file", repositoryId: "repoA", worktreeId: "wtA", path: "src/App.tsx" },
    ]);
  });
});

describe("globalSessionTargetsEqual", () => {
  it("matches same kind + worktree + id", () => {
    expect(
      globalSessionTargetsEqual(
        { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "a1" },
        { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "a1" },
      ),
    ).toBe(true);
  });

  it("differs when worktree differs even if id matches", () => {
    expect(
      globalSessionTargetsEqual(
        { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "x" },
        { kind: "thread", repositoryId: "repoB", worktreeId: "wtB", id: "x" },
      ),
    ).toBe(false);
  });
});

describe("getActiveGlobalSessionTarget", () => {
  it("resolves the active thread in the selected worktree", () => {
    const targets = build();
    const active = getActiveGlobalSessionTarget(targets, {
      activeView: "chat",
      selectedRepositoryId: "repoA",
      selectedWorktreeId: "wtA",
      selectedThreadId: "a1",
      terminalViewActive: false,
      activeTerminalTabId: null,
      activeFilePath: null,
    });
    expect(active).toMatchObject({ kind: "thread", id: "a1", worktreeId: "wtA" });
  });

  it("returns null when active thread is not in the target list", () => {
    const targets = build();
    const active = getActiveGlobalSessionTarget(targets, {
      activeView: "chat",
      selectedRepositoryId: "repoA",
      selectedWorktreeId: "wtA",
      selectedThreadId: "missing",
      terminalViewActive: false,
      activeTerminalTabId: null,
      activeFilePath: null,
    });
    expect(active).toBeNull();
  });
});

describe("MRU helpers", () => {
  const targets: GlobalSessionTarget[] = [
    { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "a1" },
    { kind: "terminal", repositoryId: "repoA", worktreeId: "wtA", id: "termA1" },
    { kind: "thread", repositoryId: "repoB", worktreeId: "wtB", id: "b1" },
  ];

  it("promotes a target to the front", () => {
    const history = promoteGlobalSessionTarget([], targets[2], targets);
    expect(history[0]).toEqual(targets[2]);
  });

  it("builds a cycle history starting with the active target", () => {
    const history = buildGlobalSessionCycleHistory([], targets, targets[0]);
    expect(history[0]).toEqual(targets[0]);
    expect(history).toHaveLength(3);
  });
});
