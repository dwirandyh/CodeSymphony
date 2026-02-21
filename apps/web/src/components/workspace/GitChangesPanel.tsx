import { useState } from "react";
import { Dot, ExternalLink, Eye, Plus, Minus, RefreshCw, Undo2, X, Loader2 } from "lucide-react";
import type { GitChangeEntry } from "@codesymphony/shared-types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";

interface GitChangesPanelProps {
  entries: GitChangeEntry[];
  branch: string;
  loading: boolean;
  committing: boolean;
  error: string | null;
  selectedFilePath?: string | null;
  onCommit: (message: string) => void;
  onReview: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onSelectFile?: (path: string) => void;
  onDiscardChange?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}

const STATUS_CONFIG: Record<string, { icon: any; className: string }> = {
  modified: { icon: Dot, className: "border-yellow-500/40 text-yellow-500 bg-yellow-500/5" },
  added: { icon: Plus, className: "border-green-500/40 text-green-500 bg-green-500/5" },
  deleted: { icon: Minus, className: "border-red-500/40 text-red-500 bg-red-500/5" },
  renamed: { icon: Dot, className: "border-blue-500/40 text-blue-500 bg-blue-500/5" },
  untracked: { icon: Plus, className: "border-green-500/40 text-green-500 bg-green-500/5" },
};

function splitFilePath(filePath: string) {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return { name: filePath, dir: "" };
  return { name: filePath.substring(lastSlash + 1), dir: filePath.substring(0, lastSlash + 1) };
}

export function GitChangesPanel({
  entries,
  branch,
  loading,
  committing,
  error,
  selectedFilePath,
  onCommit,
  onReview,
  onRefresh,
  onClose,
  onSelectFile,
  onDiscardChange,
  onOpenFile,
}: GitChangesPanelProps) {
  const [commitMessage, setCommitMessage] = useState("");

  const handleCommit = () => {
    onCommit(commitMessage.trim());
    setCommitMessage("");
  };

  return (
    <Card className="flex h-full flex-col overflow-hidden border-0 bg-transparent shadow-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
          Source Control
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground/60 hover:text-foreground"
          onClick={onClose}
          aria-label="Close Source Control"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Separator className="opacity-20" />

      {/* Commit section */}
      <div className="space-y-3 px-3 py-3">
        <Input
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder="Auto-generate if blank (Cmd+Enter)"
          className="border-border/30 bg-secondary/10 px-2.5 py-1.5 text-xs placeholder:text-muted-foreground/40 focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-offset-0"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleCommit();
            }
          }}
        />
        <Button
          size="sm"
          onClick={handleCommit}
          disabled={committing || entries.length === 0}
          className="w-full h-8 text-xs font-medium"
        >
          {committing ? (
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Committing...</span>
            </div>
          ) : (
            "Commit"
          )}
        </Button>
        {error && (
          <p className="text-[11px] text-destructive" role="alert">{error}</p>
        )}
      </div>

      <Separator className="opacity-20" />

      {/* Changes list */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Changes
            </span>
            {entries.length > 0 && (
              <Badge variant="secondary" className="h-4 min-w-4 rounded-full px-1 py-0 text-[10px] font-medium">
                {entries.length}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground/50 hover:text-foreground disabled:opacity-40"
              onClick={onReview}
              disabled={entries.length === 0}
              aria-label="Review changes"
              title="Review changes"
            >
              <Eye className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground/50 hover:text-foreground disabled:opacity-40"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh changes"
              title="Refresh changes"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
          {entries.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground/50">
              {loading ? "Loading changes..." : "No uncommitted changes"}
            </div>
          ) : (
            <div className="space-y-[1px] px-1 pb-2" role="listbox" aria-label="Changed files">
              {entries.map((entry) => {
                const { name, dir } = splitFilePath(entry.path);
                const config = STATUS_CONFIG[entry.status] ?? STATUS_CONFIG.modified;
                const isSelected = selectedFilePath === entry.path;
                const isDeleted = entry.status === "deleted";

                return (
                  <div key={entry.path} className="group relative">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => onSelectFile?.(entry.path)}
                      className={cn(
                        "flex w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary/40",
                        isSelected && "bg-secondary/60 ring-[0.5px] ring-foreground/10",
                        isDeleted && "hover:bg-red-500/5"
                      )}
                    >
                      <div className="min-w-0 flex-1 flex items-baseline gap-1 overflow-hidden">
                        <span className={cn(
                          "truncate text-xs font-semibold text-foreground min-w-0 shrink",
                          isDeleted && "line-through text-red-500/70"
                        )}>
                          {name}
                        </span>
                        {dir && (
                          <span className="truncate text-[10px] text-muted-foreground/40 min-w-0 shrink-[2]">
                            {dir}
                          </span>
                        )}
                      </div>

                      <div className="relative ml-auto flex shrink-0 items-center justify-end">
                        {/* Indicators — always visible */}
                        <div className="flex items-center gap-2 transition-opacity group-hover:opacity-0 group-hover:pointer-events-none">
                          {(entry.insertions > 0 || entry.deletions > 0) && (
                            <div className="flex items-center gap-1.5 text-[10px] font-medium whitespace-nowrap">
                              {entry.insertions > 0 && (
                                <span className="text-green-500/80">+{entry.insertions}</span>
                              )}
                              {entry.deletions > 0 && (
                                <span className="text-red-500/80">-{entry.deletions}</span>
                              )}
                            </div>
                          )}

                          <div
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border-[0.5px]",
                              config.className
                            )}
                            title={entry.status}
                          >
                            <config.icon className="h-2.5 w-2.5" />
                          </div>
                        </div>

                        {/* Hover actions (visible on hover) */}
                        <div className="absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDiscardChange?.(entry.path);
                            }}
                            title="Discard changes"
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenFile?.(entry.path);
                            }}
                            title="Open file"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </Card>
  );
}
