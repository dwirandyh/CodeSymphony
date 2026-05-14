import type {
  Repository,
  ResourceMonitorRuntimeSnapshot,
  ResourceMonitorSessionKind,
  ResourceMonitorUsage,
  ResourceMonitorWorktree,
} from "@codesymphony/shared-types";
import type { DesktopResourceMonitorSnapshot } from "../../lib/desktopResourceMonitor";
import { isRootWorktree } from "../../lib/worktree";

export type ResourceMonitorSortOption = "memory" | "cpu" | "name" | "sidebar";

export interface ResourceMonitorAppMetrics extends ResourceMonitorUsage {
  shell: ResourceMonitorUsage;
  webview: ResourceMonitorUsage;
  runtime: ResourceMonitorUsage;
  other: ResourceMonitorUsage;
}

export interface ResourceMonitorRepositoryGroup extends ResourceMonitorUsage {
  repositoryId: string;
  repositoryName: string;
  worktrees: ResourceMonitorWorktree[];
}

export interface ResourceMonitorViewModel {
  app: ResourceMonitorAppMetrics;
  worktrees: ResourceMonitorWorktree[];
  host: ResourceMonitorRuntimeSnapshot["host"];
  totalCpu: number;
  totalMemory: number;
  trackedMemorySharePercent: number;
}

function sumUsage(values: ResourceMonitorUsage[]): ResourceMonitorUsage {
  return values.reduce<ResourceMonitorUsage>(
    (accumulator, value) => ({
      cpu: accumulator.cpu + value.cpu,
      memory: accumulator.memory + value.memory,
    }),
    { cpu: 0, memory: 0 },
  );
}

export function resolveResourceMonitorSidebarOrder(repositories: Repository[]): {
  repositoryOrder: string[];
  worktreeOrder: string[];
} {
  return {
    repositoryOrder: repositories.map((repository) => repository.id),
    worktreeOrder: repositories.flatMap((repository) => {
      const rootWorktree = repository.worktrees.find((worktree) => isRootWorktree(worktree, repository)) ?? null;
      if (!rootWorktree) {
        return repository.worktrees.map((worktree) => worktree.id);
      }

      return [
        rootWorktree.id,
        ...repository.worktrees
          .filter((worktree) => worktree.id !== rootWorktree.id)
          .map((worktree) => worktree.id),
      ];
    }),
  };
}

export function mergeResourceMonitorSnapshots(input: {
  runtime: ResourceMonitorRuntimeSnapshot;
  desktop: DesktopResourceMonitorSnapshot | null;
}): ResourceMonitorViewModel {
  const runtimeSlice = input.desktop?.runtime ?? {
    cpu: input.runtime.runtime.cpu,
    memory: input.runtime.runtime.memory,
  };
  const shellSlice = input.desktop?.shell ?? { cpu: 0, memory: 0 };
  const webviewSlice = input.desktop?.webview ?? { cpu: 0, memory: 0 };
  const otherSlice = input.desktop?.other ?? { cpu: 0, memory: 0 };
  const app = {
    shell: shellSlice,
    webview: webviewSlice,
    runtime: runtimeSlice,
    other: otherSlice,
    ...sumUsage([shellSlice, webviewSlice, runtimeSlice, otherSlice]),
  };
  const worktreeTotals = sumUsage(input.runtime.worktrees);
  const totalCpu = app.cpu + worktreeTotals.cpu;
  const totalMemory = app.memory + worktreeTotals.memory;
  const trackedMemorySharePercent = input.runtime.host.totalMemory > 0
    ? (totalMemory / input.runtime.host.totalMemory) * 100
    : 0;

  return {
    app,
    worktrees: input.runtime.worktrees,
    host: input.runtime.host,
    totalCpu,
    totalMemory,
    trackedMemorySharePercent,
  };
}

export function groupResourceMonitorWorktrees(
  worktrees: ResourceMonitorWorktree[],
): ResourceMonitorRepositoryGroup[] {
  const groups = new Map<string, ResourceMonitorRepositoryGroup>();

  for (const worktree of worktrees) {
    const existingGroup = groups.get(worktree.repositoryId);
    if (existingGroup) {
      existingGroup.worktrees.push(worktree);
      existingGroup.cpu += worktree.cpu;
      existingGroup.memory += worktree.memory;
      continue;
    }

    groups.set(worktree.repositoryId, {
      repositoryId: worktree.repositoryId,
      repositoryName: worktree.repositoryName,
      cpu: worktree.cpu,
      memory: worktree.memory,
      worktrees: [worktree],
    });
  }

  return [...groups.values()];
}

function compareBySortOption(
  left: ResourceMonitorUsage & { name: string; id: string },
  right: ResourceMonitorUsage & { name: string; id: string },
  sortOption: ResourceMonitorSortOption,
  order: Map<string, number>,
): number {
  switch (sortOption) {
    case "memory":
      return right.memory - left.memory;
    case "cpu":
      return right.cpu - left.cpu;
    case "name":
      return left.name.localeCompare(right.name);
    case "sidebar":
      return (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    default:
      return 0;
  }
}

export function sortResourceMonitorGroups(input: {
  groups: ResourceMonitorRepositoryGroup[];
  sortOption: ResourceMonitorSortOption;
  repositoryOrder: string[];
  worktreeOrder: string[];
}): ResourceMonitorRepositoryGroup[] {
  const repositoryOrder = new Map(input.repositoryOrder.map((id, index) => [id, index]));
  const worktreeOrder = new Map(input.worktreeOrder.map((id, index) => [id, index]));

  return [...input.groups]
    .map((group) => ({
      ...group,
      worktrees: [...group.worktrees].sort((left, right) => compareBySortOption(
        {
          id: left.worktreeId,
          name: left.worktreeName,
          cpu: left.cpu,
          memory: left.memory,
        },
        {
          id: right.worktreeId,
          name: right.worktreeName,
          cpu: right.cpu,
          memory: right.memory,
        },
        input.sortOption,
        worktreeOrder,
      )),
    }))
    .sort((left, right) => compareBySortOption(
      {
        id: left.repositoryId,
        name: left.repositoryName,
        cpu: left.cpu,
        memory: left.memory,
      },
      {
        id: right.repositoryId,
        name: right.repositoryName,
        cpu: right.cpu,
        memory: right.memory,
      },
      input.sortOption,
      repositoryOrder,
    ));
}

export function resolveResourceMonitorSessionTab(kind: ResourceMonitorSessionKind): "terminal" | "run" {
  return kind === "run" ? "run" : "terminal";
}
