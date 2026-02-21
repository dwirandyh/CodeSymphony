import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [files, setFiles] = useState<FileDiffMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const isMobile = useIsMobile();

  const effectiveViewMode: ViewMode = isMobile ? "unified" : viewMode;

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const opts = selectedFilePath ? { filePath: selectedFilePath } : undefined;
      const { diff } = await api.getGitDiff(worktreeId, opts);
      const patches = parsePatchFiles(diff);
      const allFiles = patches.flatMap((p) => p.files);

      // Fetch full file contents in parallel to enable expandable unchanged regions
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

      setFiles(allFiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load diff");
    } finally {
      setLoading(false);
    }
  }, [worktreeId, selectedFilePath]);

  useEffect(() => {
    void fetchDiff();
  }, [fetchDiff]);

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
    for (const file of files) {
      const s = computeStats(file);
      additions += s.additions;
      deletions += s.deletions;
    }
    return { additions, deletions };
  }, [files]);

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
          onClick={() => void fetchDiff()}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Retry
        </button>
      </div>
    );
  }

  if (files.length === 0) {
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
            : `${files.length} file${files.length !== 1 ? "s" : ""} changed`}
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
          onClick={() => void fetchDiff()}
          className="rounded-sm p-1 text-muted-foreground/50 transition-colors hover:bg-secondary/40 hover:text-foreground"
          title="Refresh diff"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Diff files */}
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("space-y-3", isMobile ? "p-2" : "p-4")}>
          {files.map((file) => {
            const key = file.name;
            const isCollapsed = collapsed.has(key);
            const stats = computeStats(file);
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
