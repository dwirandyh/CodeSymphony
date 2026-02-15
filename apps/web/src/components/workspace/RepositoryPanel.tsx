import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Plus, Trash2 } from "lucide-react";
import type { Repository } from "@codesymphony/shared-types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";

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
}: RepositoryPanelProps) {
  const [expandedByRepo, setExpandedByRepo] = useState<Record<string, boolean>>({});

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

      <ScrollArea className="min-h-0 flex-1 px-1 pb-1">
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
                className={cn("p-0.5", isSelected && "text-foreground")}
                data-testid={`repository-${repository.id}`}
              >
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-8 flex-1 justify-start gap-1.5 overflow-hidden px-2 text-muted-foreground hover:text-foreground",
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
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      onSelectRepository(repository.id);
                      onCreateWorktree(repository.id);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {isExpanded ? (
                  <div className="ml-4 mt-1 space-y-1">
                    {activeWorktrees.length === 0 ? (
                      <div className="py-1 text-xs text-muted-foreground">No active worktrees yet.</div>
                    ) : null}

                    {activeWorktrees.map((worktree) => {
                      const isWorktreeSelected = selectedWorktreeId === worktree.id;

                      return (
                        <div key={worktree.id} className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "h-8 flex-1 justify-between rounded-sm px-2 text-muted-foreground hover:text-foreground",
                              isWorktreeSelected && "text-foreground",
                            )}
                            onClick={() => onSelectWorktree(repository.id, worktree.id)}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                              <span className="truncate text-xs">{worktree.branch}</span>
                            </span>
                            <Badge variant="outline" className="border-none bg-transparent text-[10px] text-muted-foreground">
                              {worktree.baseBranch}
                            </Badge>
                          </Button>

                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete worktree ${worktree.branch}`}
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => onDeleteWorktree(worktree.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
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
