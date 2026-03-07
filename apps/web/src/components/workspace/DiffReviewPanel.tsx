import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Columns2, FileText, Rows3, RefreshCw } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import { parsePatchFiles, SPLIT_WITH_NEWLINES } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs";

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

function computeStats(file: FileDiffMetadata) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions.length;
        deletions += content.deletions.length;
      }
    }
  }
  return { additions, deletions };
}

type DiffFileEntry = {
  file: FileDiffMetadata;
  stats: { additions: number; deletions: number };
};

type DiffFetchResult = {
  entries: DiffFileEntry[];
  diffLength: number;
  fileCount: number;
  fetchedFullContents: boolean;
  diffFetchDurationMs: number;
  parseDurationMs: number;
  contentFetchDurationMs: number;
  totalDurationMs: number;
};

const diffRequestCache = new Map<string, DiffFetchResult>();
const diffRequestInFlight = new Map<string, Promise<DiffFetchResult>>();

export function __resetDiffReviewPanelCacheForTests() {
  diffRequestCache.clear();
  diffRequestInFlight.clear();
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
  const [entries, setEntries] = useState<DiffFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const isMobile = useIsMobile();
  const cacheKey = `${worktreeId}::${selectedFilePath ?? "__all__"}`;
  const appliedCacheKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  const effectiveViewMode: ViewMode = isMobile ? "unified" : viewMode;

  const applyResult = useCallback((nextCacheKey: string, result: DiffFetchResult) => {
    if (!mountedRef.current) {
      return;
    }

    appliedCacheKeyRef.current = nextCacheKey;
    setEntries(result.entries);
    setCollapsed(() => result.fetchedFullContents ? new Set() : new Set(result.entries.map((entry) => entry.file.name)));
    setError(null);
    setLoading(false);
  }, []);

  const fetchDiff = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true;
    setLoading(true);
    setError(null);
    try {
      if (!force) {
        const cached = diffRequestCache.get(cacheKey);
        if (cached) {
          applyResult(cacheKey, cached);
          return;
        }
      } else {
        diffRequestCache.delete(cacheKey);
      }

      let request = diffRequestInFlight.get(cacheKey);
      if (!request) {
        request = (async (): Promise<DiffFetchResult> => {
          const fetchStartedAt = performance.now();
          const opts = selectedFilePath ? { filePath: selectedFilePath } : undefined;
          const diffStartedAt = performance.now();
          const { diff } = await api.getGitDiff(worktreeId, opts);
          const diffFetchedAt = performance.now();
          const parseStartedAt = performance.now();
          const patches = parsePatchFiles(diff);
          const allFiles = patches.flatMap((p) => p.files);
          const shouldFetchFullContents = Boolean(selectedFilePath);
          const fileFetchStartedAt = performance.now();

          if (shouldFetchFullContents) {
            await Promise.all(
              allFiles.map(async (file) => {
                try {
                  const { oldContent, newContent } = await api.getFileContents(worktreeId, file.name);
                  file.oldLines = (oldContent ?? "").split(SPLIT_WITH_NEWLINES);
                  file.newLines = (newContent ?? "").split(SPLIT_WITH_NEWLINES);
                } catch {
                  // If fetching contents fails, the diff still renders without expand
                }
              })
            );
          }

          const entries = allFiles.map((file) => ({
            file,
            stats: computeStats(file),
          }));
          const totalDurationMs = performance.now() - fetchStartedAt;
          const parseDurationMs = performance.now() - parseStartedAt;
          const contentFetchDurationMs = shouldFetchFullContents ? performance.now() - fileFetchStartedAt : 0;
          return {
            entries,
            diffLength: diff.length,
            fileCount: allFiles.length,
            fetchedFullContents: shouldFetchFullContents,
            diffFetchDurationMs: Number((diffFetchedAt - diffStartedAt).toFixed(2)),
            parseDurationMs: Number(parseDurationMs.toFixed(2)),
            contentFetchDurationMs: Number(contentFetchDurationMs.toFixed(2)),
            totalDurationMs: Number(totalDurationMs.toFixed(2)),
          };
        })();
        diffRequestInFlight.set(cacheKey, request);
      }

      const result = await request;
      if (diffRequestInFlight.get(cacheKey) === request) {
        diffRequestInFlight.delete(cacheKey);
      }
      diffRequestCache.set(cacheKey, result);
      applyResult(cacheKey, result);

    } catch (e) {
      if (diffRequestInFlight.get(cacheKey)) {
        diffRequestInFlight.delete(cacheKey);
      }
      if (!mountedRef.current) {
        return;
      }
      setError(e instanceof Error ? e.message : "Failed to load diff");
      setLoading(false);
    }
  }, [applyResult, cacheKey, selectedFilePath, worktreeId]);

  useEffect(() => {
    mountedRef.current = true;

    if (appliedCacheKeyRef.current !== cacheKey) {
      void fetchDiff();
    } else {
      setLoading(false);
    }

    return () => {
      mountedRef.current = false;
    };
  }, [cacheKey, fetchDiff]);

  const toggleFile = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const entry of entries) {
      additions += entry.stats.additions;
      deletions += entry.stats.deletions;
    }
    return { additions, deletions };
  }, [entries]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => void fetchDiff({ force: true })}
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
              onClick={() => setViewMode("split")}
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
              onClick={() => setViewMode("unified")}
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
          onClick={() => void fetchDiff({ force: true })}
          className="rounded-sm p-1 text-muted-foreground/50 transition-colors hover:bg-secondary/40 hover:text-foreground"
          title="Refresh diff"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Diff entries */}
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("space-y-3", isMobile ? "p-2" : "p-4")}>
          {entries.map((entry) => {
            const file = entry.file;
            const key = file.name;
            const isCollapsed = collapsed.has(key);
            const stats = entry.stats;
            const status = mapFileType(file.type);
            const badge = STATUS_BADGE[status] ?? STATUS_BADGE.modified;

            return (
              <div key={key} className="overflow-hidden rounded-lg border border-border/20 bg-card/40">
                {/* File header */}
                <button
                  type="button"
                  onClick={() => toggleFile(key)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/20"
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
                  <span className="min-w-0 truncate text-xs font-medium text-foreground/90">
                    {file.name}
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

                {/* Diff hunks */}
                {!isCollapsed && (
                  <div className="border-t border-border/10">
                    <FileDiff
                      fileDiff={file}
                      options={{
                        diffStyle: effectiveViewMode,
                        overflow: isMobile ? "wrap" : "scroll",
                        theme: "pierre-dark",
                        themeType: "dark",
                        disableFileHeader: true,
                        expandUnchanged: false,
                        expansionLineCount: 20,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
