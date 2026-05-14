import { describe, expect, it } from "vitest";
import type { Repository, ResourceMonitorRuntimeSnapshot } from "@codesymphony/shared-types";
import {
  groupResourceMonitorWorktrees,
  mergeResourceMonitorSnapshots,
  resolveResourceMonitorSessionTab,
  resolveResourceMonitorSidebarOrder,
  sortResourceMonitorGroups,
} from "./resourceMonitorData";

const repositories: Repository[] = [
  {
    id: "repo-1",
    name: "Alpha",
    rootPath: "/alpha",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    saveAutomation: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    worktrees: [
      {
        id: "wt-1",
        repositoryId: "repo-1",
        branch: "main",
        path: "/alpha",
        baseBranch: "main",
        status: "active",
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  {
    id: "repo-2",
    name: "Beta",
    rootPath: "/beta",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    saveAutomation: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    worktrees: [
      {
        id: "wt-2",
        repositoryId: "repo-2",
        branch: "feature",
        path: "/beta",
        baseBranch: "main",
        status: "active",
        branchRenamed: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
];

const runtimeSnapshot: ResourceMonitorRuntimeSnapshot = {
  runtime: {
    pid: 123,
    cpu: 8,
    memory: 100,
  },
  worktrees: [
    {
      worktreeId: "wt-2",
      repositoryId: "repo-2",
      repositoryName: "Beta",
      worktreeName: "feature",
      cpu: 20,
      memory: 200,
      sessions: [
        {
          sessionId: "wt-2:script-runner:abc",
          worktreeId: "wt-2",
          pid: 900,
          label: "Run Script",
          kind: "run",
          cpu: 20,
          memory: 200,
        },
      ],
    },
    {
      worktreeId: "wt-1",
      repositoryId: "repo-1",
      repositoryName: "Alpha",
      worktreeName: "main",
      cpu: 10,
      memory: 300,
      sessions: [
        {
          sessionId: "wt-1:terminal",
          worktreeId: "wt-1",
          pid: 800,
          label: "Terminal",
          kind: "terminal",
          cpu: 10,
          memory: 300,
        },
      ],
    },
  ],
  host: {
    totalMemory: 1000,
    freeMemory: 200,
    usedMemory: 800,
    memoryUsagePercent: 80,
    cpuCoreCount: 8,
    loadAverage1m: 1.2,
  },
  collectedAt: Date.now(),
};

describe("resourceMonitorData", () => {
  it("merges runtime and desktop slices without double counting worktree sessions", () => {
    const merged = mergeResourceMonitorSnapshots({
      runtime: runtimeSnapshot,
      desktop: {
        shell: { cpu: 1, memory: 10 },
        webview: { cpu: 2, memory: 20 },
        runtime: { cpu: 3, memory: 30 },
        other: { cpu: 4, memory: 40 },
      },
    });

    expect(merged.app.cpu).toBe(10);
    expect(merged.app.memory).toBe(100);
    expect(merged.totalCpu).toBe(40);
    expect(merged.totalMemory).toBe(600);
    expect(merged.trackedMemorySharePercent).toBe(60);
  });

  it("groups and sorts repositories by sidebar order", () => {
    const grouped = groupResourceMonitorWorktrees(runtimeSnapshot.worktrees);
    const order = resolveResourceMonitorSidebarOrder(repositories);
    const sorted = sortResourceMonitorGroups({
      groups: grouped,
      sortOption: "sidebar",
      repositoryOrder: order.repositoryOrder,
      worktreeOrder: order.worktreeOrder,
    });

    expect(sorted.map((group) => group.repositoryId)).toEqual(["repo-1", "repo-2"]);
    expect(sorted[0]?.worktrees[0]?.worktreeId).toBe("wt-1");
    expect(sorted[1]?.worktrees[0]?.worktreeId).toBe("wt-2");
  });

  it("matches the repository panel order by placing the root worktree before branch worktrees", () => {
    const sidebarRepositories: Repository[] = [
      {
        id: "repo-1",
        name: "Alpha",
        rootPath: "/alpha/root",
        defaultBranch: "main",
        setupScript: null,
        teardownScript: null,
        runScript: null,
        saveAutomation: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        worktrees: [
          {
            id: "wt-branch",
            repositoryId: "repo-1",
            branch: "feature-x",
            path: "/alpha/branch",
            baseBranch: "main",
            status: "active",
            branchRenamed: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "wt-root",
            repositoryId: "repo-1",
            branch: "feature-root",
            path: "/alpha/root",
            baseBranch: "main",
            status: "active",
            branchRenamed: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ];
    const grouped = groupResourceMonitorWorktrees([
      {
        worktreeId: "wt-branch",
        repositoryId: "repo-1",
        repositoryName: "Alpha",
        worktreeName: "feature-x",
        cpu: 1,
        memory: 200,
        sessions: [],
      },
      {
        worktreeId: "wt-root",
        repositoryId: "repo-1",
        repositoryName: "Alpha",
        worktreeName: "feature-root",
        cpu: 1,
        memory: 100,
        sessions: [],
      },
    ]);

    const order = resolveResourceMonitorSidebarOrder(sidebarRepositories);
    const sorted = sortResourceMonitorGroups({
      groups: grouped,
      sortOption: "sidebar",
      repositoryOrder: order.repositoryOrder,
      worktreeOrder: order.worktreeOrder,
    });

    expect(sorted[0]?.worktrees.map((worktree) => worktree.worktreeId)).toEqual(["wt-root", "wt-branch"]);
  });

  it("maps session kinds to the expected bottom panel tabs", () => {
    expect(resolveResourceMonitorSessionTab("run")).toBe("run");
    expect(resolveResourceMonitorSessionTab("terminal")).toBe("terminal");
    expect(resolveResourceMonitorSessionTab("other")).toBe("terminal");
  });
});
