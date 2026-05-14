import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type {
  ResourceMonitorProcessInfo,
  ResourceMonitorProcessSnapshot,
} from "../src/services/resourceMonitorProcessSnapshot.js";

const mockCaptureResourceMonitorProcessSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../src/services/resourceMonitorProcessSnapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/resourceMonitorProcessSnapshot.js")>(
    "../src/services/resourceMonitorProcessSnapshot.js",
  );

  return {
    ...actual,
    captureResourceMonitorProcessSnapshot: mockCaptureResourceMonitorProcessSnapshot,
  };
});

import { createResourceMonitorService } from "../src/services/resourceMonitorService.js";

function buildProcessInfo(
  pid: number,
  ppid: number,
  cpu: number,
  memory: number,
  command: string,
): ResourceMonitorProcessInfo {
  return { pid, ppid, cpu, memory, command };
}

function buildSnapshot(): ResourceMonitorProcessSnapshot {
  const runtimePid = process.pid;

  return {
    byPid: new Map<number, ResourceMonitorProcessInfo>([
      [runtimePid, buildProcessInfo(runtimePid, 1, 2, 20, "node")],
      [100, buildProcessInfo(100, runtimePid, 10, 100, "zsh")],
      [101, buildProcessInfo(101, 100, 5, 50, "node build")],
      [110, buildProcessInfo(110, runtimePid, 6, 60, "zsh")],
      [111, buildProcessInfo(111, 110, 4, 40, "python")],
      [120, buildProcessInfo(120, runtimePid, 1, 10, "helper")],
    ]),
    childrenOf: new Map<number, number[]>([
      [1, [runtimePid]],
      [runtimePid, [100, 110, 120]],
      [100, [101]],
      [110, [111]],
    ]),
  };
}

function buildTrackedSessionSnapshot(): ResourceMonitorProcessSnapshot {
  const runtimePid = process.pid;

  return {
    byPid: new Map<number, ResourceMonitorProcessInfo>([
      [runtimePid, buildProcessInfo(runtimePid, 1, 2, 20, "node")],
      [100, buildProcessInfo(100, runtimePid, 10, 100, "zsh")],
      [101, buildProcessInfo(101, 100, 5, 50, "node build")],
      [120, buildProcessInfo(120, runtimePid, 1, 10, "helper")],
      [130, buildProcessInfo(130, runtimePid, 7, 70, "claude")],
      [131, buildProcessInfo(131, 130, 3, 30, "rg")],
    ]),
    childrenOf: new Map<number, number[]>([
      [1, [runtimePid]],
      [runtimePid, [100, 120, 130]],
      [100, [101]],
      [130, [131]],
    ]),
  };
}

function buildMixedSessionOrderingSnapshot(): ResourceMonitorProcessSnapshot {
  const runtimePid = process.pid;

  return {
    byPid: new Map<number, ResourceMonitorProcessInfo>([
      [runtimePid, buildProcessInfo(runtimePid, 1, 2, 20, "node")],
      [100, buildProcessInfo(100, runtimePid, 10, 100, "zsh")],
      [101, buildProcessInfo(101, 100, 5, 50, "node build")],
      [130, buildProcessInfo(130, runtimePid, 7, 70, "claude")],
      [131, buildProcessInfo(131, 130, 3, 30, "rg")],
      [140, buildProcessInfo(140, runtimePid, 6, 60, "codex")],
      [141, buildProcessInfo(141, 140, 2, 20, "rg")],
      [150, buildProcessInfo(150, runtimePid, 4, 40, "node run script")],
      [151, buildProcessInfo(151, 150, 1, 10, "bash")],
    ]),
    childrenOf: new Map<number, number[]>([
      [1, [runtimePid]],
      [runtimePid, [100, 130, 140, 150]],
      [100, [101]],
      [130, [131]],
      [140, [141]],
      [150, [151]],
    ]),
  };
}

describe("resourceMonitorService", () => {
  const findMany = vi.fn();
  const prisma = {
    worktree: {
      findMany,
    },
  } as unknown as PrismaClient;
  const terminalService = {
    listResourceSessions: vi.fn(),
  };
  const resourceMonitorSessionTracker = {
    upsertSession: vi.fn(),
    removeSession: vi.fn(),
    listSessions: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureResourceMonitorProcessSnapshot.mockResolvedValue(buildSnapshot());
    terminalService.listResourceSessions.mockReturnValue([
      {
        sessionId: "wt-1:terminal",
        pid: 100,
        resolvedCwd: "/tmp/wt-1",
      },
      {
        sessionId: "default",
        pid: 110,
        resolvedCwd: "/tmp",
      },
    ]);
    resourceMonitorSessionTracker.listSessions.mockReturnValue([]);
    findMany.mockResolvedValue([
      {
        id: "wt-1",
        branch: "main",
        repository: {
          id: "repo-1",
          name: "Alpha",
        },
      },
    ]);
  });

  it("keeps unassigned terminal resources in the runtime slice and hides them from worktree groups", async () => {
    const service = createResourceMonitorService(prisma, terminalService, resourceMonitorSessionTracker);

    const snapshot = await service.getSnapshot();

    expect(snapshot.runtime).toEqual({
      pid: process.pid,
      cpu: 13,
      memory: 130,
    });
    expect(snapshot.worktrees).toEqual([
      {
        worktreeId: "wt-1",
        repositoryId: "repo-1",
        repositoryName: "Alpha",
        worktreeName: "main",
        cpu: 15,
        memory: 150,
        sessions: [
          {
            sessionId: "wt-1:terminal",
            worktreeId: "wt-1",
            pid: 100,
            label: "Terminal",
            kind: "terminal",
            cpu: 15,
            memory: 150,
          },
        ],
      },
    ]);
    expect(snapshot.worktrees.some((worktree) => worktree.repositoryName === "Unassigned Sessions")).toBe(false);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ["wt-1"],
        },
      },
      select: {
        id: true,
        branch: true,
        repository: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  });

  it("merges active tracked agent sessions into worktree groups without losing runtime totals", async () => {
    mockCaptureResourceMonitorProcessSnapshot.mockResolvedValue(buildTrackedSessionSnapshot());
    terminalService.listResourceSessions.mockReturnValue([
      {
        sessionId: "wt-1:terminal",
        pid: 100,
        resolvedCwd: "/tmp/wt-1",
      },
    ]);
    resourceMonitorSessionTracker.listSessions.mockReturnValue([
      {
        sessionId: "thread:t-2:agent:claude",
        worktreeId: "wt-2",
        pid: 130,
        label: "Agent: Claude | Review monitor behavior",
        kind: "other",
      },
    ]);
    findMany.mockResolvedValue([
      {
        id: "wt-1",
        branch: "main",
        repository: {
          id: "repo-1",
          name: "Alpha",
        },
      },
      {
        id: "wt-2",
        branch: "feature/resource-monitor",
        repository: {
          id: "repo-2",
          name: "Beta",
        },
      },
    ]);

    const service = createResourceMonitorService(prisma, terminalService, resourceMonitorSessionTracker);

    const snapshot = await service.getSnapshot();

    expect(snapshot.runtime).toEqual({
      pid: process.pid,
      cpu: 3,
      memory: 30,
    });
    expect(snapshot.worktrees).toEqual([
      {
        worktreeId: "wt-1",
        repositoryId: "repo-1",
        repositoryName: "Alpha",
        worktreeName: "main",
        cpu: 15,
        memory: 150,
        sessions: [
          {
            sessionId: "wt-1:terminal",
            worktreeId: "wt-1",
            pid: 100,
            label: "Terminal",
            kind: "terminal",
            cpu: 15,
            memory: 150,
          },
        ],
      },
      {
        worktreeId: "wt-2",
        repositoryId: "repo-2",
        repositoryName: "Beta",
        worktreeName: "feature/resource-monitor",
        cpu: 10,
        memory: 100,
        sessions: [
          {
            sessionId: "thread:t-2:agent:claude",
            worktreeId: "wt-2",
            pid: 130,
            label: "Agent: Claude | Review monitor behavior",
            kind: "other",
            cpu: 10,
            memory: 100,
          },
        ],
      },
    ]);
  });

  it("orders active agents before terminal and run sessions within a worktree", async () => {
    mockCaptureResourceMonitorProcessSnapshot.mockResolvedValue(buildMixedSessionOrderingSnapshot());
    terminalService.listResourceSessions.mockReturnValue([
      {
        sessionId: "wt-1:terminal",
        pid: 100,
        resolvedCwd: "/tmp/wt-1",
      },
      {
        sessionId: "wt-1:script-runner:abc",
        pid: 150,
        resolvedCwd: "/tmp/wt-1",
      },
    ]);
    resourceMonitorSessionTracker.listSessions.mockReturnValue([
      {
        sessionId: "thread:t-1:agent:claude",
        worktreeId: "wt-1",
        pid: 130,
        label: "Agent: Claude | Investigate monitor",
        kind: "other",
      },
      {
        sessionId: "thread:t-2:agent:codex",
        worktreeId: "wt-1",
        pid: 140,
        label: "Agent: Codex | Tighten desktop metrics",
        kind: "other",
      },
    ]);

    const service = createResourceMonitorService(prisma, terminalService, resourceMonitorSessionTracker);

    const snapshot = await service.getSnapshot();
    const targetWorktree = snapshot.worktrees.find((worktree) => worktree.worktreeId === "wt-1");

    expect(targetWorktree?.sessions.map((session) => session.label)).toEqual([
      "Agent: Claude | Investigate monitor",
      "Agent: Codex | Tighten desktop metrics",
      "Terminal",
      "Run Script",
    ]);
  });
});
