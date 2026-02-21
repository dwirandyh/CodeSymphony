import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Pencil, Plus, Trash2 } from "lucide-react";
import type { Repository } from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";

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
  const [worktreeStats, setWorktreeStats] = useState<Record<string, { insertions: number; deletions: number; fileCount: number }>>({});
  const mountedRef = useRef(true);

  const activeWorktreeIds = useMemo(
    () => repositories.flatMap((r) => r.worktrees.filter((w) => w.status === "active").map((w) => w.id)),
    [repositories],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (activeWorktreeIds.length === 0) return;

    const fetchStats = async () => {
      const results: Record<string, { insertions: number; deletions: number; fileCount: number }> = {};
      await Promise.allSettled(
        activeWorktreeIds.map(async (id) => {
          try {
            const status = await api.getGitStatus(id);
            const insertions = status.entries.reduce((sum, e) => sum + e.insertions, 0);
            const deletions = status.entries.reduce((sum, e) => sum + e.deletions, 0);
            results[id] = { insertions, deletions, fileCount: status.entries.length };
          } catch {
            // ignore — stale data is acceptable
          }
        }),
      );
      if (mountedRef.current) setWorktreeStats(results);
    };

    void fetchStats();
    const interval = setInterval(() => void fetchStats(), 5_000);
    return () => clearInterval(interval);
  }, [activeWorktreeIds]);

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
                    <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate text-left text-xs font-medium">{repository.name}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{activeWorktrees.length} active</span>
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Add worktree for ${repository.name}`}
                    title="Create worktree from main"
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
                    {activeWorktrees.length === 0 ? (
                      <div className="flex items-center gap-2 py-1">
                        <div className="text-xs text-muted-foreground">No active worktrees yet.</div>
                      </div>
                    ) : null}

                    {activeWorktrees.map((worktree) => {
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
                              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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

                              <div className="flex h-4 items-center gap-1.5 pl-5">
                                {stats && (stats.insertions > 0 || stats.deletions > 0) ? (
                                  <span className="flex items-center gap-1 text-[10px] leading-none">
                                    <span className="text-green-500">+{stats.insertions}</span>
                                    <span className="text-red-500">-{stats.deletions}</span>
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="relative mt-0.5 ml-auto flex shrink-0 items-center justify-end">
                              {/* Default: baseBranch label */}
                              <div className="flex items-center transition-opacity group-hover/wt:pointer-events-none group-hover/wt:opacity-0">
                                <span className="whitespace-nowrap text-[10px] text-muted-foreground">{worktree.baseBranch}</span>
                              </div>

                              {/* Hover: delete button */}
                              <div className="absolute inset-0 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/wt:opacity-100">
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
                            </div>
                          </button>
                        </div>
                      );
                    })}
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
