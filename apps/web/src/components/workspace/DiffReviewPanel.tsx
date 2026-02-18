import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Columns2, FileText, Rows3, RefreshCw } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { parseDiff, countStats, fileStats, type DiffFile, type DiffHunk, type DiffLine } from "../../lib/diffParser";
import { api } from "../../lib/api";

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

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function buildSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    // Collect contiguous deletion block
    const deletions: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "deletion") {
      deletions.push(lines[i]);
      i++;
    }

    // Collect contiguous addition block
    const additions: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "addition") {
      additions.push(lines[i]);
      i++;
    }

    // Pair them side-by-side
    const maxLen = Math.max(deletions.length, additions.length);
    for (let j = 0; j < maxLen; j++) {
      rows.push({
        left: j < deletions.length ? deletions[j] : null,
        right: j < additions.length ? additions[j] : null,
      });
    }
  }

  return rows;
}

export function DiffReviewPanel({ worktreeId, selectedFilePath }: DiffReviewPanelProps) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("split");

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const opts = selectedFilePath ? { filePath: selectedFilePath } : undefined;
      const { diff } = await api.getGitDiff(worktreeId, opts);
      setFiles(parseDiff(diff));
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

  const totals = countStats(files);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Summary header */}
      <div className="flex items-center gap-3 border-b border-border/20 px-4 py-2.5">
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

        {/* View mode toggle */}
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
        <div className="space-y-3 p-4">
          {files.map((file) => {
            const key = file.newPath || file.oldPath;
            const isCollapsed = collapsed.has(key);
            const stats = fileStats(file);
            const badge = STATUS_BADGE[file.status] ?? STATUS_BADGE.modified;

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
                    {file.newPath}
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
                  <div className="overflow-x-auto border-t border-border/10">
                    {viewMode === "unified" ? (
                      <UnifiedDiffTable hunks={file.hunks} />
                    ) : (
                      <SplitDiffTable hunks={file.hunks} />
                    )}
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

function UnifiedDiffTable({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-[20px]">
      <tbody>
        {hunks.map((hunk, hIdx) => (
          <Fragment key={hIdx}>
            <tr className="bg-blue-500/[0.06]">
              <td className="w-[1px] whitespace-nowrap border-r border-border/10 px-2 text-right text-[11px] text-blue-400/40">
                ...
              </td>
              <td className="w-[1px] whitespace-nowrap border-r border-border/10 px-2 text-right text-[11px] text-blue-400/40">
                ...
              </td>
              <td className="px-3 py-0.5 text-[11px] text-blue-400/60">
                {hunk.header.replace(/^@@.*@@\s*/, "")}
              </td>
            </tr>

            {hunk.lines.map((line, lIdx) => (
              <tr
                key={lIdx}
                className={cn(
                  line.type === "addition" && "bg-green-500/[0.08]",
                  line.type === "deletion" && "bg-red-500/[0.08]",
                )}
              >
                <td className="w-[1px] select-none whitespace-nowrap border-r border-border/10 px-2 text-right text-muted-foreground/25">
                  {line.oldLine ?? ""}
                </td>
                <td className="w-[1px] select-none whitespace-nowrap border-r border-border/10 px-2 text-right text-muted-foreground/25">
                  {line.newLine ?? ""}
                </td>
                <td className="whitespace-pre px-3">
                  <span
                    className={cn(
                      line.type === "addition" && "text-green-300",
                      line.type === "deletion" && "text-red-300",
                      line.type === "context" && "text-foreground/60",
                    )}
                  >
                    {line.type === "addition"
                      ? "+"
                      : line.type === "deletion"
                        ? "-"
                        : " "}
                    {line.content}
                  </span>
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function SplitDiffTable({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-[20px]">
      <tbody>
        {hunks.map((hunk, hIdx) => {
          const splitRows = buildSplitRows(hunk);
          return (
            <Fragment key={hIdx}>
              {/* Hunk header */}
              <tr className="bg-blue-500/[0.06]">
                <td className="w-[1px] whitespace-nowrap border-r border-border/10 px-2 text-right text-[11px] text-blue-400/40">
                  ...
                </td>
                <td className="w-1/2 border-r border-border/10 px-3 py-0.5 text-[11px] text-blue-400/60">
                  {hunk.header.replace(/^@@.*@@\s*/, "")}
                </td>
                <td className="w-[1px] whitespace-nowrap border-r border-border/10 px-2 text-right text-[11px] text-blue-400/40">
                  ...
                </td>
                <td className="w-1/2 px-3 py-0.5 text-[11px] text-blue-400/60" />
              </tr>

              {splitRows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {/* Left (old) side */}
                  <td
                    className={cn(
                      "w-[1px] select-none whitespace-nowrap border-r border-border/10 px-2 text-right text-muted-foreground/25",
                      row.left?.type === "deletion" && "bg-red-500/[0.08]",
                    )}
                  >
                    {row.left?.oldLine ?? ""}
                  </td>
                  <td
                    className={cn(
                      "w-1/2 whitespace-pre border-r border-border/20 px-3",
                      row.left?.type === "deletion" && "bg-red-500/[0.08]",
                      row.left?.type === "context" && "",
                      !row.left && "bg-muted/5",
                    )}
                  >
                    {row.left && (
                      <span
                        className={cn(
                          row.left.type === "deletion" && "text-red-300",
                          row.left.type === "context" && "text-foreground/60",
                        )}
                      >
                        {row.left.type === "deletion" ? "-" : " "}
                        {row.left.content}
                      </span>
                    )}
                  </td>

                  {/* Right (new) side */}
                  <td
                    className={cn(
                      "w-[1px] select-none whitespace-nowrap border-r border-border/10 px-2 text-right text-muted-foreground/25",
                      row.right?.type === "addition" && "bg-green-500/[0.08]",
                    )}
                  >
                    {row.right?.newLine ?? ""}
                  </td>
                  <td
                    className={cn(
                      "w-1/2 whitespace-pre px-3",
                      row.right?.type === "addition" && "bg-green-500/[0.08]",
                      row.right?.type === "context" && "",
                      !row.right && "bg-muted/5",
                    )}
                  >
                    {row.right && (
                      <span
                        className={cn(
                          row.right.type === "addition" && "text-green-300",
                          row.right.type === "context" && "text-foreground/60",
                        )}
                      >
                        {row.right.type === "addition" ? "+" : " "}
                        {row.right.content}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
