import { describe, expect, it } from "vitest";
import { buildGlobalSwitcherItems } from "./sessionSwitcherItems";
import type { GlobalSessionTarget } from "./globalSessionTargets";

const sources = {
  selectedWorktreeId: "wtA",
  worktrees: [
    {
      worktreeId: "wtA",
      branch: "main",
      threads: [
        { id: "t1", title: "Fix auth bug" },
        { id: "t2", title: "" },
      ],
      terminalTabs: [
        { id: "term1", title: "bun dev" },
        { id: "term2", title: "" },
      ],
    },
    {
      worktreeId: "wtB",
      branch: "feature/x",
      threads: [{ id: "b1", title: "Other worktree thread" }],
      terminalTabs: [],
    },
  ],
};

function build(targets: GlobalSessionTarget[]) {
  return buildGlobalSwitcherItems(targets, sources);
}

describe("buildGlobalSwitcherItems", () => {
  it("resolves thread label from title with fallback", () => {
    const items = build([
      { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "t1" },
      { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "t2" },
    ]);
    expect(items[0]).toMatchObject({ kind: "thread", label: "Fix auth bug" });
    expect(items[1].label).toBe("Untitled thread");
  });

  it("resolves terminal label from title with fallback", () => {
    const items = build([
      { kind: "terminal", repositoryId: "repoA", worktreeId: "wtA", id: "term1" },
      { kind: "terminal", repositoryId: "repoA", worktreeId: "wtA", id: "term2" },
    ]);
    expect(items[0]).toMatchObject({ kind: "terminal", label: "bun dev" });
    expect(items[1].label).toBe("Terminal");
  });

  it("resolves review + file labels", () => {
    const items = build([
      { kind: "review", repositoryId: "repoA", worktreeId: "wtA" },
      { kind: "file", repositoryId: "repoA", worktreeId: "wtA", path: "src/components/App.tsx" },
    ]);
    expect(items[0]).toMatchObject({ kind: "review", label: "Review" });
    expect(items[1]).toMatchObject({ kind: "file", label: "App.tsx", sublabel: "src/components" });
  });

  it("sets the worktree branch context label for every target", () => {
    const items = build([
      { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "t1" },
      { kind: "thread", repositoryId: "repoB", worktreeId: "wtB", id: "b1" },
    ]);
    expect(items[0].contextLabel).toBe("main");
    expect(items[1].contextLabel).toBe("feature/x");
    expect(items[1].label).toBe("Other worktree thread");
  });

  it("produces a stable unique key per target", () => {
    const items = build([
      { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "t1" },
      { kind: "thread", repositoryId: "repoB", worktreeId: "wtB", id: "b1" },
    ]);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
  });

  it("falls back gracefully for unknown ids", () => {
    const items = build([
      { kind: "thread", repositoryId: "repoA", worktreeId: "wtA", id: "missing" },
      { kind: "terminal", repositoryId: "repoA", worktreeId: "wtA", id: "missing" },
    ]);
    expect(items[0].label).toBe("Untitled thread");
    expect(items[1].label).toBe("Terminal");
  });
});
