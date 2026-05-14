import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Repository, ResourceMonitorSessionKind, ResourceMonitorUsage, ResourceMonitorWorktree } from "@codesymphony/shared-types";
import { ArrowDownWideNarrow, ChevronDown, ChevronRight, Cpu, RefreshCw } from "lucide-react";
import { api } from "../../lib/api";
import { getDesktopResourceMonitorSnapshot } from "../../lib/desktopResourceMonitor";
import { cn } from "../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  groupResourceMonitorWorktrees,
  mergeResourceMonitorSnapshots,
  resolveResourceMonitorSessionTab,
  resolveResourceMonitorSidebarOrder,
  sortResourceMonitorGroups,
  type ResourceMonitorAppMetrics,
  type ResourceMonitorRepositoryGroup,
  type ResourceMonitorSortOption,
} from "./resourceMonitorData";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const DESKTOP_METRICS_TIMEOUT_MS = 750;

const SORT_LABELS: Record<ResourceMonitorSortOption, string> = {
  memory: "Memory",
  cpu: "CPU",
  name: "Name",
  sidebar: "Sidebar",
};

type ResourceMonitorTriggerVariant = "default" | "titlebar";

function formatCpu(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMemory(bytes: number): string {
  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }

  return `${(bytes / MB).toFixed(1)} MB`;
}

function formatCompactMemory(bytes: number): string {
  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)}G`;
  }

  return `${(bytes / MB).toFixed(1)}M`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Desktop resource metrics timed out"));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function MetricCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="px-4 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">
        {label}
      </div>
      <div className="mt-1 text-[18px] font-medium tracking-tight text-foreground">
        {value}
      </div>
    </div>
  );
}

function AppSliceRow({
  label,
  usage,
}: {
  label: string;
  usage: ResourceMonitorUsage;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-secondary/25">
      <span className="truncate">{label}</span>
      <div className="flex items-center gap-4 tabular-nums">
        <span className="w-14 text-right">{formatCpu(usage.cpu)}</span>
        <span className="w-20 text-right">{formatMemory(usage.memory)}</span>
      </div>
    </div>
  );
}

function AppSection({
  app,
}: {
  app: ResourceMonitorAppMetrics;
}) {
  const showOther = app.other.cpu > 0 || app.other.memory > 0;

  return (
    <div className="border-b border-border/60 py-2">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[13px] font-medium text-foreground">CodeSymphony App</span>
        <div className="flex items-center gap-4 tabular-nums text-[13px] text-foreground">
          <span className="w-14 text-right">{formatCpu(app.cpu)}</span>
          <span className="w-20 text-right">{formatMemory(app.memory)}</span>
        </div>
      </div>

      <AppSliceRow label="Shell" usage={app.shell} />
      <AppSliceRow label="Webview" usage={app.webview} />
      <AppSliceRow label="Runtime" usage={app.runtime} />
      {showOther ? <AppSliceRow label="Other" usage={app.other} /> : null}
    </div>
  );
}

function RepositoryRows({
  groups,
  collapsedRepositories,
  collapsedWorktrees,
  onToggleRepository,
  onToggleWorktree,
  onSelectWorktree,
  onSelectSession,
}: {
  groups: ResourceMonitorRepositoryGroup[];
  collapsedRepositories: Set<string>;
  collapsedWorktrees: Set<string>;
  onToggleRepository: (repositoryId: string) => void;
  onToggleWorktree: (worktreeId: string) => void;
  onSelectWorktree: (repositoryId: string, worktreeId: string) => void;
  onSelectSession: (repositoryId: string, worktreeId: string, kind: ResourceMonitorSessionKind) => void;
}) {
  return groups.map((group, index) => {
    const repositoryCollapsed = collapsedRepositories.has(group.repositoryId);

    return (
      <div
        key={group.repositoryId}
        className={cn(index > 0 && "border-t border-border/40")}
      >
        <button
          type="button"
          onClick={() => onToggleRepository(group.repositoryId)}
          className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-secondary/25"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {repositoryCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {group.repositoryName}
            </span>
          </div>
          <div className="flex items-center gap-4 tabular-nums text-[12px] text-foreground/90">
            <span className="w-14 text-right">{formatCpu(group.cpu)}</span>
            <span className="w-20 text-right">{formatMemory(group.memory)}</span>
          </div>
        </button>

        {!repositoryCollapsed ? group.worktrees.map((worktree) => {
          const worktreeCollapsed = collapsedWorktrees.has(worktree.worktreeId);
          const hasSessions = worktree.sessions.length > 0;

          return (
            <div key={worktree.worktreeId}>
              <div className="flex items-center transition-colors hover:bg-secondary/20">
                {hasSessions ? (
                  <button
                    type="button"
                    onClick={() => onToggleWorktree(worktree.worktreeId)}
                    className="ml-3 flex h-8 w-5 items-center justify-center text-muted-foreground/70"
                    aria-label={worktreeCollapsed ? "Expand worktree" : "Collapse worktree"}
                  >
                    {worktreeCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                ) : (
                  <span className="ml-3 h-8 w-5" />
                )}

                <button
                  type="button"
                  onClick={() => onSelectWorktree(worktree.repositoryId, worktree.worktreeId)}
                  className="flex flex-1 items-center justify-between px-1 pr-3 py-2 text-left"
                >
                  <span className="truncate text-[12px] text-foreground">{worktree.worktreeName}</span>
                  <div className="flex items-center gap-4 tabular-nums text-[12px] text-foreground/85">
                    <span className="w-14 text-right">{formatCpu(worktree.cpu)}</span>
                    <span className="w-20 text-right">{formatMemory(worktree.memory)}</span>
                  </div>
                </button>
              </div>

              {!worktreeCollapsed ? worktree.sessions.map((session) => (
                <button
                  type="button"
                  key={session.sessionId}
                  onClick={() => onSelectSession(worktree.repositoryId, worktree.worktreeId, session.kind)}
                  className="flex w-full items-center justify-between pl-12 pr-3 py-1.5 text-left transition-colors hover:bg-secondary/15"
                >
                  <span className="truncate text-[11px] text-muted-foreground">{session.label}</span>
                  <div className="flex items-center gap-4 tabular-nums text-[11px] text-muted-foreground">
                    <span className="w-14 text-right">{formatCpu(session.cpu)}</span>
                    <span className="w-20 text-right">{formatMemory(session.memory)}</span>
                  </div>
                </button>
              )) : null}
            </div>
          );
        }) : null}
      </div>
    );
  });
}

export function ResourceMonitor({
  desktopApp,
  runtimePid,
  repositories,
  popoverAlign = "end",
  triggerVariant = "default",
  onSelectWorktree,
  onSelectSession,
}: {
  desktopApp: boolean;
  runtimePid: number | null;
  repositories: Repository[];
  popoverAlign?: "start" | "end";
  triggerVariant?: ResourceMonitorTriggerVariant;
  onSelectWorktree: (repositoryId: string, worktreeId: string) => void;
  onSelectSession: (repositoryId: string, worktreeId: string, tab: "terminal" | "run") => void;
}) {
  const [open, setOpen] = useState(false);
  const [sortOption, setSortOption] = useState<ResourceMonitorSortOption>("memory");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [collapsedRepositories, setCollapsedRepositories] = useState<Set<string>>(() => new Set());
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => new Set());

  const sidebarOrder = useMemo(
    () => resolveResourceMonitorSidebarOrder(repositories),
    [repositories],
  );

  const snapshotQuery = useQuery({
    queryKey: ["resource-monitor", runtimePid],
    enabled: desktopApp,
    queryFn: async () => {
      const runtimeSnapshotPromise = api.getResourceMonitorSnapshot();
      const desktopSnapshotPromise = withTimeout(
        getDesktopResourceMonitorSnapshot(runtimePid),
        DESKTOP_METRICS_TIMEOUT_MS,
      ).catch(() => null);
      const [runtimeSnapshot, desktopSnapshot] = await Promise.all([
        runtimeSnapshotPromise,
        desktopSnapshotPromise,
      ]);

      return mergeResourceMonitorSnapshots({
        runtime: runtimeSnapshot,
        desktop: desktopSnapshot,
      });
    },
    refetchInterval: () => open ? 2_000 : 15_000,
    staleTime: open ? 1_000 : 10_000,
    retry: false,
  });
  const refetchSnapshot = snapshotQuery.refetch;

  useEffect(() => {
    if (!open) {
      return;
    }

    void refetchSnapshot();
  }, [open, refetchSnapshot]);

  const groupedWorktrees = useMemo(
    () => sortResourceMonitorGroups({
      groups: groupResourceMonitorWorktrees(snapshotQuery.data?.worktrees ?? []),
      sortOption,
      repositoryOrder: sidebarOrder.repositoryOrder,
      worktreeOrder: sidebarOrder.worktreeOrder,
    }),
    [sidebarOrder.repositoryOrder, sidebarOrder.worktreeOrder, snapshotQuery.data?.worktrees, sortOption],
  );

  if (!desktopApp) {
    return null;
  }

  const totalMemoryLabel = snapshotQuery.data ? formatMemory(snapshotQuery.data.totalMemory) : null;
  const triggerMemoryLabel = snapshotQuery.data
    ? triggerVariant === "titlebar"
      ? formatCompactMemory(snapshotQuery.data.totalMemory)
      : totalMemoryLabel
    : null;
  const triggerClassName = triggerVariant === "titlebar"
    ? "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
    : "inline-flex h-9 items-center gap-2 rounded-md border border-border/55 bg-card/60 px-3 text-muted-foreground transition-colors hover:bg-secondary/35 hover:text-foreground";
  const iconClassName = triggerVariant === "titlebar" ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0";
  const labelClassName = triggerVariant === "titlebar" ? "tabular-nums" : "text-[12px] font-medium tabular-nums";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label="Open resource usage"
          data-testid="resource-monitor-trigger"
        >
          <Cpu className={iconClassName} />
          {triggerMemoryLabel ? <span className={labelClassName}>{triggerMemoryLabel}</span> : null}
        </button>
      </PopoverTrigger>

      <PopoverContent align={popoverAlign} sideOffset={10} className="w-[42rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border-border/60 bg-card/95 p-0 shadow-[0_24px_80px_rgba(15,23,42,0.26)]">
        <div className="border-b border-border/60 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/90">
                Resource Usage
              </div>
            </div>

            <div className="flex items-center gap-1">
              <Popover open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary/35 hover:text-foreground"
                    aria-label="Choose sort option"
                  >
                    <ArrowDownWideNarrow className="h-3.5 w-3.5" />
                    <span>{SORT_LABELS[sortOption]}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-36 p-1">
                  {(["memory", "cpu", "name", "sidebar"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        setSortOption(option);
                        setSortMenuOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] transition-colors",
                        option === sortOption
                          ? "bg-secondary/70 text-foreground"
                          : "text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
                      )}
                    >
                      {SORT_LABELS[option]}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>

              <button
                type="button"
                onClick={() => void snapshotQuery.refetch()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/35 hover:text-foreground"
                aria-label="Refresh resource usage"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", snapshotQuery.isFetching && "animate-spin")} />
              </button>
            </div>
          </div>

          {snapshotQuery.data ? (
            <>
              <div className="mt-3 grid grid-cols-3 divide-x divide-border/50 rounded-xl border border-border/50 bg-background/45">
                <MetricCard label="CPU" value={formatCpu(snapshotQuery.data.totalCpu)} />
                <MetricCard label="Memory" value={formatMemory(snapshotQuery.data.totalMemory)} />
                <MetricCard label="RAM Share" value={formatPercent(snapshotQuery.data.trackedMemorySharePercent)} />
              </div>

              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary/45">
                <div
                  className="h-full rounded-full bg-primary/70 transition-[width] duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, snapshotQuery.data.trackedMemorySharePercent))}%` }}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="max-h-[58vh] overflow-y-auto">
          {snapshotQuery.error ? (
            <div className="px-4 py-6 text-sm text-destructive">
              {snapshotQuery.error instanceof Error ? snapshotQuery.error.message : "Failed to load resource usage."}
            </div>
          ) : null}

          {!snapshotQuery.data && !snapshotQuery.error ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              Loading resource usage…
            </div>
          ) : null}

          {snapshotQuery.data ? (
            <>
              <AppSection app={snapshotQuery.data.app} />
              {groupedWorktrees.length > 0 ? (
                <RepositoryRows
                  groups={groupedWorktrees}
                  collapsedRepositories={collapsedRepositories}
                  collapsedWorktrees={collapsedWorktrees}
                  onToggleRepository={(repositoryId) => {
                    setCollapsedRepositories((current) => {
                      const next = new Set(current);
                      if (next.has(repositoryId)) {
                        next.delete(repositoryId);
                      } else {
                        next.add(repositoryId);
                      }
                      return next;
                    });
                  }}
                  onToggleWorktree={(worktreeId) => {
                    setCollapsedWorktrees((current) => {
                      const next = new Set(current);
                      if (next.has(worktreeId)) {
                        next.delete(worktreeId);
                      } else {
                        next.add(worktreeId);
                      }
                      return next;
                    });
                  }}
                  onSelectWorktree={onSelectWorktree}
                  onSelectSession={(repositoryId, worktreeId, kind) => {
                    if (kind === "terminal" || kind === "run") {
                      onSelectSession(repositoryId, worktreeId, resolveResourceMonitorSessionTab(kind));
                    } else {
                      onSelectWorktree(repositoryId, worktreeId);
                    }
                    setOpen(false);
                  }}
                />
              ) : (
                <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
                  No tracked worktree activity
                </div>
              )}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
