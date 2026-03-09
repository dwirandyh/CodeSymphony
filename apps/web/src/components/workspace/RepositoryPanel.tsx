import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Pencil, Plus, Trash2 } from "lucide-react";
import type { GitStatus, Repository } from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import { isRootWorktree } from "../../lib/worktree";
import { gitStatusQueryOptions } from "../../hooks/queries/useGitStatus";
import { useWorktreeStatuses } from "../../hooks/queries/useWorktreeStatuses";
import type { WorktreeThreadUiStatus } from "../../pages/workspace/hooks/worktreeThreadStatus";

type RepositoryPanelProps = {
  repositories: Repository[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  loadingRepos: boolean;
  submittingRepo: boolean;
  submittingWorktree: boolean;
  onAttachRepository: () => void;
  onSelectRepository: (repositoryId: string) => void;
  onCreateWorktree: (repositoryId: string) => void;
  onSelectWorktree: (repositoryId: string, worktreeId: string) => void;
  onDeleteWorktree: (worktreeId: string) => void;
  onRenameWorktreeBranch: (worktreeId: string, newBranch: string) => void;
};

const WORKTREE_STATUS_META: Record<WorktreeThreadUiStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  waiting_approval: { label: "Waiting approval", variant: "destructive" },
  review_plan: { label: "Review plan", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  idle: { label: "Idle", variant: "outline" },
};

function WorktreeStatusBadge({ status }: { status: WorktreeThreadUiStatus | undefined }) {
  const resolvedStatus = status ?? "idle";
  const meta = WORKTREE_STATUS_META[resolvedStatus];
  return (
    <Badge
      variant={meta.variant}
      className="pointer-events-none h-4 rounded-md px-1.5 py-0 text-[10px] leading-none shadow-sm"
      data-testid={`worktree-status-${resolvedStatus}`}
    >
      {meta.label}
    </Badge>
  );
}

export function RepositoryPanel({
  repositories,
  selectedRepositoryId,
  selectedWorktreeId,
  loadingRepos,
  submittingRepo,
  submittingWorktree,
  onAttachRepository,
  onSelectRepository,
  onCreateWorktree,
  onSelectWorktree,
  onDeleteWorktree,
  onRenameWorktreeBranch,
}: RepositoryPanelProps) {
  const [expandedByRepo, setExpandedByRepo] = useState<Record<string, boolean>>({});
  const [editingWorktreeId, setEditingWorktreeId] = useState<string | null>(null);
  const [editingBranchValue, setEditingBranchValue] = useState("");

  const activeWorktreeIds = useMemo(
    () => repositories.flatMap((r) => r.worktrees.filter((w) => w.status === "active").map((w) => w.id)),
    [repositories],
  );
  const worktreeStatuses = useWorktreeStatuses(repositories);
  const gitStatusQueries = useQueries({
    queries: activeWorktreeIds.map((worktreeId) => gitStatusQueryOptions(worktreeId)),
  });
  const worktreeStats = useMemo(() => {
    return activeWorktreeIds.reduce<Record<string, { insertions: number; deletions: number; fileCount: number }>>((acc, worktreeId, index) => {
      const status = gitStatusQueries[index]?.data as GitStatus | undefined;
      if (!status) {
        return acc;
      }

      const insertions = status.entries.reduce((sum, entry) => sum + entry.insertions, 0);
      const deletions = status.entries.reduce((sum, entry) => sum + entry.deletions, 0);
      acc[worktreeId] = {
        insertions,
        deletions,
        fileCount: status.entries.length,
      };
      return acc;
    }, {});
  }, [activeWorktreeIds, gitStatusQueries]);

  useEffect(() => {
    if (!selectedRepositoryId) {
      return;
    }

    setExpandedByRepo((current) => {
      if (current[selectedRepositoryId] != null) {
        return current;
      }

      return {
        ...current,
        [selectedRepositoryId]: true,
      };
    });
  }, [selectedRepositoryId]);

  function toggleRepository(repositoryId: string) {
    setExpandedByRepo((current) => ({
      ...current,
      [repositoryId]: !current[repositoryId],
    }));
    onSelectRepository(repositoryId);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5">
        <h2 className="text-xs font-medium tracking-[0.03em] text-muted-foreground">Workspace ({repositories.length})</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Attach repository"
          title="Attach repository"
          disabled={submittingRepo}
          onClick={onAttachRepository}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {loadingRepos ? <div className="px-2 py-2 text-xs text-muted-foreground">Loading repositories...</div> : null}

      <ScrollArea className="min-h-0 flex-1 px-1 pb-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        {repositories.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No repositories added yet.
          </div>
        ) : null}

        <div className="space-y-0.5">
          {repositories.map((repository) => {
            const isSelected = selectedRepositoryId === repository.id;
            const activeWorktrees = repository.worktrees.filter((worktree) => worktree.status === "active");
            const rootWorkspace = activeWorktrees.find((worktree) => isRootWorktree(worktree, repository)) ?? null;
            const branchWorktrees = rootWorkspace
              ? activeWorktrees.filter((worktree) => worktree.id !== rootWorkspace.id)
              : activeWorktrees;
            const isExpanded = expandedByRepo[repository.id] ?? isSelected;

            return (
              <article
                key={repository.id}
                className={cn("min-w-0 p-0.5", isSelected && "text-foreground")}
                data-testid={`repository-${repository.id}`}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-8 min-w-0 flex-1 justify-start gap-1.5 overflow-hidden px-2 text-muted-foreground hover:text-foreground",
                      isSelected && "text-foreground",
                    )}
                    onClick={() => toggleRepository(repository.id)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="truncate text-left text-xs font-medium">{repository.name}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{branchWorktrees.length} worktrees</span>
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Add worktree for ${repository.name}`}
                    title={`Create worktree from ${repository.defaultBranch}`}
                    disabled={submittingWorktree}
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      onSelectRepository(repository.id);
                      onCreateWorktree(repository.id);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {isExpanded ? (
                  <div className="ml-4 mt-1 min-w-0 space-y-1">
                    {!rootWorkspace && branchWorktrees.length === 0 ? (
                      <div className="flex items-center gap-2 py-1">
                        <div className="text-xs text-muted-foreground">No active worktrees yet.</div>
                      </div>
                    ) : null}

                    {rootWorkspace ? (
                      <div className="space-y-1">
                        <div className="group/wt relative">
                          <button
                            type="button"
                            className={cn(
                              "flex w-full min-w-0 items-start gap-1.5 overflow-hidden rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-secondary/40",
                              selectedWorktreeId === rootWorkspace.id && "bg-secondary/60 text-foreground ring-[0.5px] ring-foreground/10",
                            )}
                            onClick={() => onSelectWorktree(repository.id, rootWorkspace.id)}
                          >
                            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden pr-20">
                                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                  <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                                </span>
                                <span className="truncate text-xs">{rootWorkspace.branch}</span>
                              </div>

                              <div className="flex h-4 items-center gap-1.5 pl-5 pr-20">
                                {worktreeStats[rootWorkspace.id] && ((worktreeStats[rootWorkspace.id].insertions > 0) || (worktreeStats[rootWorkspace.id].deletions > 0)) ? (
                                  <span className="flex items-center gap-1 text-[10px] leading-none">
                                    <span className="text-green-500">+{worktreeStats[rootWorkspace.id].insertions}</span>
                                    <span className="text-red-500">-{worktreeStats[rootWorkspace.id].deletions}</span>
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="absolute top-1.5 right-2 flex items-center justify-end">
                              <WorktreeStatusBadge status={worktreeStatuses[rootWorkspace.id]?.kind} />
                            </div>
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {branchWorktrees.length > 0 ? (
                      <div className="space-y-1">
                        {branchWorktrees.map((worktree) => {
                          const isWorktreeSelected = selectedWorktreeId === worktree.id;
                          const stats = worktreeStats[worktree.id];

                          return (
                            <div key={worktree.id} className="group/wt relative">
                              <button
                                type="button"
                                className={cn(
                                  "flex w-full min-w-0 items-start gap-1.5 overflow-hidden rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:bg-secondary/40",
                                  isWorktreeSelected && "bg-secondary/60 text-foreground ring-[0.5px] ring-foreground/10",
                                )}
                                onClick={() => onSelectWorktree(repository.id, worktree.id)}
                              >
                                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                                  <div className="flex min-w-0 items-center gap-1.5 overflow-hidden pr-20">
                                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                      <GitBranch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                                    </span>
                                    {editingWorktreeId === worktree.id ? (
                                      <input
                                        type="text"
                                        className="min-w-0 flex-1 rounded border border-input bg-background px-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                                        value={editingBranchValue}
                                        autoFocus
                                        onChange={(e) => setEditingBranchValue(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            const trimmed = editingBranchValue.trim();
                                            if (trimmed && trimmed !== worktree.branch) {
                                              onRenameWorktreeBranch(worktree.id, trimmed);
                                            }
                                            setEditingWorktreeId(null);
                                          }
                                          if (e.key === "Escape") {
                                            setEditingWorktreeId(null);
                                          }
                                        }}
                                        onBlur={() => {
                                          const trimmed = editingBranchValue.trim();
                                          if (trimmed && trimmed !== worktree.branch) {
                                            onRenameWorktreeBranch(worktree.id, trimmed);
                                          }
                                          setEditingWorktreeId(null);
                                        }}
                                      />
                                    ) : (
                                      <span
                                        className="truncate text-xs"
                                        onDoubleClick={(e) => {
                                          e.stopPropagation();
                                          setEditingWorktreeId(worktree.id);
                                          setEditingBranchValue(worktree.branch);
                                        }}
                                      >
                                        {worktree.branch}
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex h-4 items-center gap-1.5 pl-5 pr-20">
                                    {stats && (stats.insertions > 0 || stats.deletions > 0) ? (
                                      <span className="flex items-center gap-1 text-[10px] leading-none">
                                        <span className="text-green-500">+{stats.insertions}</span>
                                        <span className="text-red-500">-{stats.deletions}</span>
                                      </span>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="absolute top-1.5 right-2 flex items-center justify-end transition-opacity group-hover/wt:pointer-events-none group-hover/wt:opacity-0">
                                  <WorktreeStatusBadge status={worktreeStatuses[worktree.id]?.kind} />
                                </div>

                                <div className="absolute top-0 right-2 bottom-0 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/wt:opacity-100">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingWorktreeId(worktree.id);
                                      setEditingBranchValue(worktree.branch);
                                    }}
                                    title="Rename branch"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onDeleteWorktree(worktree.id);
                                    }}
                                    title="Delete worktree"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </ScrollArea>
    </section>
  );
}
