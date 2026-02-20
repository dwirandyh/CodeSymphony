import { useState } from "react";
import { Check, Eye, RefreshCw, X } from "lucide-react";
import type { GitChangeEntry } from "@codesymphony/shared-types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Textarea } from "../ui/textarea";
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
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  modified: { label: "M", className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400" },
  added: { label: "A", className: "border-green-500/40 bg-green-500/10 text-green-400" },
  deleted: { label: "D", className: "border-red-500/40 bg-red-500/10 text-red-400" },
  renamed: { label: "R", className: "border-blue-500/40 bg-blue-500/10 text-blue-400" },
  untracked: { label: "U", className: "border-green-600/40 bg-green-600/10 text-green-500" },
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
}: GitChangesPanelProps) {
  const [commitMessage, setCommitMessage] = useState("");

  const handleCommit = () => {
    if (!commitMessage.trim()) return;
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
        <div className="relative">
          <Textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Message (Cmd+Enter to commit)"
            className="min-h-[68px] resize-none border-border/30 bg-secondary/10 px-2.5 py-1.5 pb-6 text-xs placeholder:text-muted-foreground/40 focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-offset-0"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commitMessage.trim()) {
                e.preventDefault();
                handleCommit();
              }
            }}
          />
          <div className="absolute right-2 bottom-1.5 text-[10px] text-muted-foreground/40">
            {commitMessage.length} chars
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleCommit}
          disabled={!commitMessage.trim() || committing || entries.length === 0}
          className="w-full h-8 text-xs font-medium"
        >
          {committing ? "Committing..." : "Commit"}
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

        <ScrollArea className="min-h-0 flex-1">
          {entries.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground/50">
              {loading ? "Loading changes..." : "No uncommitted changes"}
            </div>
          ) : (
            <div className="space-y-px px-1 pb-2" role="listbox" aria-label="Changed files">
              {entries.map((entry) => {
                const { name, dir } = splitFilePath(entry.path);
                const config = STATUS_CONFIG[entry.status] ?? STATUS_CONFIG.modified;
                const isSelected = selectedFilePath === entry.path;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => onSelectFile?.(entry.path)}
                    className={cn(
                      "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-secondary/30",
                      isSelected && "bg-primary/10 ring-1 ring-primary/30",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className={cn("truncate text-xs", isSelected ? "text-foreground" : "text-foreground/90")}>
                        {name}
                      </div>
                      {dir && (
                        <div className="truncate text-[10px] leading-tight text-muted-foreground/40">{dir}</div>
                      )}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-[18px] min-w-[18px] shrink-0 justify-center rounded px-1 py-0 text-[10px] font-bold leading-none",
                        config.className,
                      )}
                      title={entry.status}
                    >
                      {config.label}
                    </Badge>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </Card>
  );
}
