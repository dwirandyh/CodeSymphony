import { memo, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Columns2, FileText, Rows3, RefreshCw } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { useGitDiffReview, type GitDiffReviewEntry } from "../../hooks/queries/useGitDiffReview";

interface DiffReviewPanelProps {
  worktreeId: string;
  selectedFilePath?: string | null;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  modified: { label: "M", className: "text-yellow-400" },
  added: { label: "A", className: "text-green-400" },
  deleted: { label: "D", className: "text-red-400" },
  renamed: { label: "R", className: "text-blue-400" },
};

type ViewMode = "split" | "unified";

const DIFF_ENTRY_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "0 520px",
};

function mapFileType(type: FileDiffMetadata["type"]): string {
  switch (type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

function splitFilePath(path: string) {
  const lastSlashIdx = path.lastIndexOf("/");
  if (lastSlashIdx === -1) {
    return { fileName: path, directory: null };
  }

  return {
    fileName: path.slice(lastSlashIdx + 1),
    directory: path.slice(0, lastSlashIdx + 1),
  };
}

function estimateDiffBodyHeight(entry: GitDiffReviewEntry, isMobile: boolean): number {
  const changedLineCount = entry.stats.additions + entry.stats.deletions;
  const hunkCount = entry.file.hunks.length;
  const lineHeight = isMobile ? 18 : 20;
  const hunkOverhead = isMobile ? 56 : 72;
  const baseHeight = isMobile ? 160 : 220;
  const maxHeight = isMobile ? 2200 : 2800;

  return Math.min(
    maxHeight,
    Math.max(baseHeight, changedLineCount * lineHeight + hunkCount * hunkOverhead),
  );
}

function useNearScrollViewport(root: HTMLDivElement | null, rootMargin = "1200px 0px") {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (isNearViewport) {
      return;
    }

    const target = targetRef.current;
    if (!target) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }

    if (!root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      {
        root,
        rootMargin,
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [isNearViewport, root, rootMargin]);

  return { isNearViewport, targetRef };
}

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
}

export function DiffReviewPanel({ worktreeId, selectedFilePath }: DiffReviewPanelProps) {
  const { data, error, isLoading, isFetching, refetch, dataUpdatedAt } = useGitDiffReview(worktreeId, selectedFilePath ?? null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const pendingCollapseScrollRestoreRef = useRef<{
    headerElement: HTMLButtonElement;
    relativeTop: number;
  } | null>(null);
  const isMobile = useIsMobile();
  const entries = data?.entries ?? [];

  const effectiveViewMode: ViewMode = isMobile ? "unified" : viewMode;
  const deferredViewMode = useDeferredValue(effectiveViewMode);

  useEffect(() => {
    if (!data) {
      return;
    }

    startTransition(() => {
      setCollapsed(() => new Set());
    });
  }, [data, dataUpdatedAt, selectedFilePath, worktreeId]);

  useLayoutEffect(() => {
    const pending = pendingCollapseScrollRestoreRef.current;
    if (!pending || !scrollRoot) {
      return;
    }

    const rootTop = scrollRoot.getBoundingClientRect().top;
    const nextRelativeTop = pending.headerElement.getBoundingClientRect().top - rootTop;
    scrollRoot.scrollTop += nextRelativeTop - pending.relativeTop;
    pendingCollapseScrollRestoreRef.current = null;
  }, [collapsed, scrollRoot]);

  const toggleFile = useCallback((path: string, headerElement: HTMLButtonElement | null) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        pendingCollapseScrollRestoreRef.current = null;
        next.delete(path);
        return next;
      }

      if (scrollRoot && headerElement) {
        const rootTop = scrollRoot.getBoundingClientRect().top;
        pendingCollapseScrollRestoreRef.current = {
          headerElement,
          relativeTop: headerElement.getBoundingClientRect().top - rootTop,
        };
      } else {
        pendingCollapseScrollRestoreRef.current = null;
      }

      next.add(path);
      return next;
    });
  }, [scrollRoot]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const entry of entries) {
      additions += entry.stats.additions;
      deletions += entry.stats.deletions;
    }
    return { additions, deletions };
  }, [entries]);

  const handleScrollAreaRef = useCallback((node: HTMLDivElement | null) => {
    setScrollRoot((current) => current === node ? current : node);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading diff...
      </div>
    );
  }

  if (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to load diff";

    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{errorMessage}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Retry
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground/60">
        {selectedFilePath ? (
          <>
            <p>No changes for this file</p>
            <p className="text-[11px] text-muted-foreground/40">The file may have been committed or reverted.</p>
          </>
        ) : (
          "No changes to review"
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Summary header */}
      <div className={cn("flex items-center gap-3 border-b border-border/20 py-2.5", isMobile ? "px-3" : "px-4")}>
        <span className="text-xs font-medium text-muted-foreground">
          {selectedFilePath
            ? selectedFilePath.split("/").pop()
            : `${entries.length} file${entries.length !== 1 ? "s" : ""} changed`}
        </span>
        {totals.additions > 0 && (
          <span className="text-xs font-semibold text-green-400">+{totals.additions}</span>
        )}
        {totals.deletions > 0 && (
          <span className="text-xs font-semibold text-red-400">-{totals.deletions}</span>
        )}
        <div className="flex-1" />

        {/* View mode toggle — hidden on mobile */}
        {!isMobile && (
          <div className="flex items-center gap-0.5 rounded-md border border-border/20 p-0.5">
            <button
              type="button"
              onClick={() => {
                startTransition(() => {
                  setViewMode("split");
                });
              }}
              aria-pressed={viewMode === "split"}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
                viewMode === "split"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Side-by-side view"
            >
              <Columns2 className="h-3 w-3" />
              Split
            </button>
            <button
              type="button"
              onClick={() => {
                startTransition(() => {
                  setViewMode("unified");
                });
              }}
              aria-pressed={viewMode === "unified"}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
                viewMode === "unified"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Unified view"
            >
              <Rows3 className="h-3 w-3" />
              Unified
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded-sm p-1 text-muted-foreground/50 transition-colors hover:bg-secondary/40 hover:text-foreground"
          title="Refresh diff"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </button>
      </div>

      {/* Diff entries */}
      <ScrollArea ref={handleScrollAreaRef} className="min-h-0 flex-1">
        <div className={cn("space-y-3", isMobile ? "p-2" : "p-4")}>
          {entries.map((entry) => {
            const file = entry.file;
            const key = file.name;
            return (
              <DiffReviewEntryCard
                key={key}
                entry={entry}
                isCollapsed={collapsed.has(key)}
                isMobile={isMobile}
                isSelected={selectedFilePath === key}
                scrollRoot={scrollRoot}
                viewMode={deferredViewMode}
                onToggle={toggleFile}
              />
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

const DiffReviewEntryCard = memo(function DiffReviewEntryCard({
  entry,
  isCollapsed,
  isMobile,
  isSelected,
  scrollRoot,
  viewMode,
  onToggle,
}: {
  entry: GitDiffReviewEntry;
  isCollapsed: boolean;
  isMobile: boolean;
  isSelected: boolean;
  scrollRoot: HTMLDivElement | null;
  viewMode: ViewMode;
  onToggle: (path: string, headerElement: HTMLButtonElement | null) => void;
}) {
  const file = entry.file;
  const key = file.name;
  const stats = entry.stats;
  const status = mapFileType(file.type);
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.modified;
  const headerRef = useRef<HTMLButtonElement | null>(null);
  const { fileName, directory } = useMemo(() => splitFilePath(file.name), [file.name]);
  const estimatedDiffBodyHeight = useMemo(() => estimateDiffBodyHeight(entry, isMobile), [entry, isMobile]);
  const { isNearViewport, targetRef } = useNearScrollViewport(scrollRoot, isSelected ? "1600px 0px" : "1200px 0px");
  const shouldRenderDiff = !isCollapsed && (isSelected || isNearViewport);

  return (
    <div
      ref={targetRef}
      className="rounded-lg border border-border/20 bg-card/40"
      style={DIFF_ENTRY_STYLE}
    >
      <button
        ref={headerRef}
        type="button"
        onClick={() => onToggle(key, headerRef.current)}
        aria-expanded={!isCollapsed}
        title={file.name}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary",
          isCollapsed
            ? "relative bg-card"
            : "sticky top-0 z-10 border-b border-border/10 bg-card",
        )}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
        <span className={cn("shrink-0 text-[11px] font-bold", badge.className)}>
          {badge.label}
        </span>
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
        <span className="min-w-0 flex flex-1 items-baseline gap-1 overflow-hidden">
          <span className="truncate text-xs font-medium text-foreground/90">
            {fileName}
          </span>
          {directory && (
            <span className="truncate text-[11px] text-muted-foreground/55">
              {directory}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 gap-2 pl-2 text-[11px]">
          {stats.additions > 0 && (
            <span className="font-semibold text-green-400">+{stats.additions}</span>
          )}
          {stats.deletions > 0 && (
            <span className="font-semibold text-red-400">-{stats.deletions}</span>
          )}
        </span>
      </button>

      {!isCollapsed && (
        <div className="overflow-hidden border-t border-border/10">
          {shouldRenderDiff ? (
            <FileDiff
              fileDiff={file}
              options={{
                diffStyle: viewMode,
                overflow: isMobile ? "wrap" : "scroll",
                theme: "pierre-dark",
                themeType: "dark",
                disableFileHeader: true,
                expandUnchanged: false,
                expansionLineCount: 20,
              }}
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex items-center px-3 py-4 text-xs text-muted-foreground/45"
              style={{ minHeight: `${estimatedDiffBodyHeight}px` }}
            >
              Preparing diff...
            </div>
          )}
        </div>
      )}
    </div>
  );
});
