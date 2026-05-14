import os from "node:os";
import type { PrismaClient } from "@prisma/client";
import type {
  ResourceMonitorRuntimeSnapshot,
  ResourceMonitorSession,
  ResourceMonitorSessionKind,
  ResourceMonitorWorktree,
} from "@codesymphony/shared-types";
import {
  captureResourceMonitorProcessSnapshot,
  getSubtreeResources,
  sumResourcesForPids,
} from "./resourceMonitorProcessSnapshot.js";
import type { ResourceMonitorSessionTracker, TrackedResourceSession } from "./resourceMonitorSessionTracker.js";

const UNASSIGNED_WORKTREE_ID = "__unassigned__";

type TerminalService = {
  listResourceSessions: () => Array<{
    sessionId: string;
    pid: number;
    requestedCwd?: string;
    resolvedCwd: string;
  }>;
};

type AttributedResourceSession = {
  sessionId: string;
  worktreeId: string;
  pid: number;
  label: string;
  kind: ResourceMonitorSessionKind;
};

type WorktreeMetadata = {
  worktreeId: string;
  repositoryId: string;
  repositoryName: string;
  worktreeName: string;
};

function normalizeFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
}

function createHostMetrics(): ResourceMonitorRuntimeSnapshot["host"] {
  const totalMemory = normalizeFiniteNumber(os.totalmem());
  const freeMemory = normalizeFiniteNumber(os.freemem());
  const usedMemory = Math.max(0, totalMemory - freeMemory);

  return {
    totalMemory,
    freeMemory,
    usedMemory,
    memoryUsagePercent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: normalizeFiniteNumber(os.loadavg()[0]),
  };
}

function classifySession(sessionId: string): {
  worktreeId: string;
  label: string;
  kind: ResourceMonitorSessionKind;
} {
  const runScriptMatch = /^([^:]+):script-runner:/.exec(sessionId);
  if (runScriptMatch?.[1]) {
    return {
      worktreeId: runScriptMatch[1],
      label: "Run Script",
      kind: "run",
    };
  }

  const terminalMatch = /^([^:]+):terminal(?::|$)/.exec(sessionId);
  if (terminalMatch?.[1]) {
    return {
      worktreeId: terminalMatch[1],
      label: "Terminal",
      kind: "terminal",
    };
  }

  const genericMatch = /^([^:]+):/.exec(sessionId);
  if (genericMatch?.[1] && genericMatch[1] !== "default") {
    return {
      worktreeId: genericMatch[1],
      label: "Terminal Session",
      kind: "other",
    };
  }

  return {
    worktreeId: UNASSIGNED_WORKTREE_ID,
    label: "Global Terminal",
    kind: "other",
  };
}

function isValidPid(pid: unknown): pid is number {
  return Number.isInteger(pid) && Number(pid) > 0;
}

function normalizeTerminalSession(rawSession: {
  sessionId: string;
  pid: number;
}): AttributedResourceSession | null {
  if (!isValidPid(rawSession.pid)) {
    return null;
  }

  const classification = classifySession(rawSession.sessionId);
  if (classification.worktreeId === UNASSIGNED_WORKTREE_ID) {
    // Global/default sessions stay in the runtime slice so totals remain truthful
    // without surfacing an "Unassigned Sessions" bucket in the UI.
    return null;
  }

  return {
    sessionId: rawSession.sessionId,
    worktreeId: classification.worktreeId,
    pid: rawSession.pid,
    label: classification.label,
    kind: classification.kind,
  };
}

function normalizeTrackedSession(session: TrackedResourceSession): AttributedResourceSession | null {
  if (
    session.sessionId.trim().length === 0
    || session.worktreeId.trim().length === 0
    || session.label.trim().length === 0
    || !isValidPid(session.pid)
  ) {
    return null;
  }

  return {
    sessionId: session.sessionId,
    worktreeId: session.worktreeId,
    pid: session.pid,
    label: session.label,
    kind: session.kind,
  };
}

async function loadWorktreeMetadata(
  prisma: PrismaClient,
  worktreeIds: string[],
): Promise<Map<string, WorktreeMetadata>> {
  const result = new Map<string, WorktreeMetadata>();
  if (worktreeIds.length === 0) {
    return result;
  }

  const worktrees = await prisma.worktree.findMany({
    where: {
      id: {
        in: worktreeIds,
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

  for (const worktree of worktrees) {
    result.set(worktree.id, {
      worktreeId: worktree.id,
      repositoryId: worktree.repository.id,
      repositoryName: worktree.repository.name,
      worktreeName: worktree.branch,
    });
  }

  return result;
}

function getFallbackWorktreeMetadata(worktreeId: string): WorktreeMetadata {
  return {
    worktreeId,
    repositoryId: worktreeId,
    repositoryName: "Unknown Repository",
    worktreeName: `Worktree ${worktreeId.slice(0, 8)}`,
  };
}

function sortSessions(sessions: ResourceMonitorSession[]): ResourceMonitorSession[] {
  function resolveSessionOrder(session: ResourceMonitorSession): number {
    if (session.kind === "other" && session.label.startsWith("Agent: ")) {
      return 0;
    }

    if (session.kind === "terminal") {
      return 1;
    }

    if (session.kind === "run") {
      return 2;
    }

    return 3;
  }

  return [...sessions].sort((left, right) => {
    const kindDelta = resolveSessionOrder(left) - resolveSessionOrder(right);
    if (kindDelta !== 0) {
      return kindDelta;
    }

    return left.label.localeCompare(right.label);
  });
}

export function createResourceMonitorService(
  prisma: PrismaClient,
  terminalService: TerminalService,
  resourceMonitorSessionTracker?: ResourceMonitorSessionTracker,
) {
  async function getSnapshot(): Promise<ResourceMonitorRuntimeSnapshot> {
    const processSnapshot = await captureResourceMonitorProcessSnapshot();
    const rawSessions = [
      ...terminalService.listResourceSessions()
        .map((session) => normalizeTerminalSession(session))
        .filter((session): session is AttributedResourceSession => session !== null),
      ...(resourceMonitorSessionTracker?.listSessions() ?? [])
        .map((session) => normalizeTrackedSession(session))
        .filter((session): session is AttributedResourceSession => session !== null),
    ];

    const sessionMetrics: ResourceMonitorSession[] = [];
    const attributedSessionPidSet = new Set<number>();

    for (const rawSession of rawSessions) {
      const subtreeResources = getSubtreeResources(processSnapshot, rawSession.pid);
      for (const pid of subtreeResources.pids) {
        attributedSessionPidSet.add(pid);
      }

      sessionMetrics.push({
        sessionId: rawSession.sessionId,
        worktreeId: rawSession.worktreeId,
        pid: rawSession.pid,
        label: rawSession.label,
        kind: rawSession.kind,
        cpu: normalizeFiniteNumber(subtreeResources.cpu),
        memory: normalizeFiniteNumber(subtreeResources.memory),
      });
    }

    const runtimeSubtreeResources = getSubtreeResources(processSnapshot, process.pid);
    const runtimeOnlyPids = runtimeSubtreeResources.pids.filter((pid) => !attributedSessionPidSet.has(pid));
    const runtimeOnlyResources = sumResourcesForPids(processSnapshot, runtimeOnlyPids);

    const groupedSessions = new Map<string, ResourceMonitorSession[]>();
    for (const session of sessionMetrics) {
      const existingSessions = groupedSessions.get(session.worktreeId);
      if (existingSessions) {
        existingSessions.push(session);
        continue;
      }

      groupedSessions.set(session.worktreeId, [session]);
    }

    const metadataByWorktreeId = await loadWorktreeMetadata(
      prisma,
      [...groupedSessions.keys()],
    );

    const worktrees: ResourceMonitorWorktree[] = [...groupedSessions.entries()]
      .map(([worktreeId, sessions]) => {
        const metadata = metadataByWorktreeId.get(worktreeId) ?? getFallbackWorktreeMetadata(worktreeId);
        const sortedSessions = sortSessions(sessions);
        const totals = sortedSessions.reduce(
          (accumulator, session) => ({
            cpu: accumulator.cpu + session.cpu,
            memory: accumulator.memory + session.memory,
          }),
          { cpu: 0, memory: 0 },
        );

        return {
          worktreeId: metadata.worktreeId,
          repositoryId: metadata.repositoryId,
          repositoryName: metadata.repositoryName,
          worktreeName: metadata.worktreeName,
          cpu: normalizeFiniteNumber(totals.cpu),
          memory: normalizeFiniteNumber(totals.memory),
          sessions: sortedSessions,
        };
      })
      .sort((left, right) => {
        const repositoryDelta = left.repositoryName.localeCompare(right.repositoryName);
        if (repositoryDelta !== 0) {
          return repositoryDelta;
        }

        return left.worktreeName.localeCompare(right.worktreeName);
      });

    return {
      runtime: {
        pid: process.pid,
        cpu: normalizeFiniteNumber(runtimeOnlyResources.cpu),
        memory: normalizeFiniteNumber(runtimeOnlyResources.memory),
      },
      worktrees,
      host: createHostMetrics(),
      collectedAt: Date.now(),
    };
  }

  return {
    getSnapshot,
  };
}
