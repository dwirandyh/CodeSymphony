import { memo } from "react";
import { Settings } from "lucide-react";
import type { Repository } from "@codesymphony/shared-types";
import { RepositoryPanel } from "../../components/workspace/RepositoryPanel";
import { cn } from "../../lib/utils";
import { useSidebarResize } from "./hooks/useSidebarResize";
import type { RepositoryPanelDropPosition } from "./repositoryPanelPreferences";

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  repositories,
  selectedRepositoryId,
  selectedWorktreeId,
  hiddenRepositoryIds,
  expandedByRepo,
  loadingRepos,
  submittingRepo,
  submittingWorktree,
  enableRepositoryMetadata = true,
  isVisible = true,
  onOpenSettings,
  onAttachRepository,
  onSelectRepository,
  onToggleRepositoryExpand,
  onSetRepositoryVisibility,
  onShowAllRepositories,
  onReorderRepositories,
  onCreateWorktree,
  onSelectWorktree,
  onDeleteWorktree,
  onRenameWorktreeBranch,
  onPrefetchWorktree,
}: {
  repositories: Repository[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  hiddenRepositoryIds: string[];
  expandedByRepo: Record<string, boolean>;
  loadingRepos: boolean;
  submittingRepo: boolean;
  submittingWorktree: boolean;
  enableRepositoryMetadata?: boolean;
  isVisible?: boolean;
  onOpenSettings: () => void;
  onAttachRepository: () => void;
  onSelectRepository: (repositoryId: string) => void;
  onToggleRepositoryExpand: (repositoryId: string, nextExpanded: boolean) => void;
  onSetRepositoryVisibility: (repositoryId: string, visible: boolean) => void;
  onShowAllRepositories: () => void;
  onReorderRepositories: (draggedRepositoryId: string, targetRepositoryId: string, position: RepositoryPanelDropPosition) => void;
  onCreateWorktree: (repositoryId: string) => void;
  onSelectWorktree: (repositoryId: string, worktreeId: string, preferredThreadId?: string | null) => void;
  onDeleteWorktree: (worktreeId: string) => void;
  onRenameWorktreeBranch: (worktreeId: string, newBranch: string) => void;
  onPrefetchWorktree?: (worktreeId: string, preferredThreadId?: string | null) => void;
}) {
  const { sidebarWidth, sidebarDragging, handleSidebarMouseDown, panelRef } = useSidebarResize(300);

  return (
    <>
      <aside
        ref={panelRef}
        className={cn(
          "mb-1 hidden min-h-0 shrink-0 flex-col overflow-hidden bg-card/75 p-2 sm:mb-2 lg:mb-0 lg:p-3",
          isVisible ? "lg:flex" : "lg:hidden",
        )}
        style={{ width: `${sidebarWidth}px` }}
        aria-hidden={isVisible ? undefined : "true"}
      >
        <div className="mb-3">
          <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
          <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <RepositoryPanel
            repositories={repositories}
            selectedRepositoryId={selectedRepositoryId}
            selectedWorktreeId={selectedWorktreeId}
            enableMetadataQueries={enableRepositoryMetadata}
            hiddenRepositoryIds={hiddenRepositoryIds}
            expandedByRepo={expandedByRepo}
            loadingRepos={loadingRepos}
            submittingRepo={submittingRepo}
            submittingWorktree={submittingWorktree}
            onAttachRepository={onAttachRepository}
            onSelectRepository={onSelectRepository}
            onToggleRepositoryExpand={onToggleRepositoryExpand}
            onSetRepositoryVisibility={onSetRepositoryVisibility}
            onShowAllRepositories={onShowAllRepositories}
            onReorderRepositories={onReorderRepositories}
            onCreateWorktree={onCreateWorktree}
            onSelectWorktree={onSelectWorktree}
            onDeleteWorktree={onDeleteWorktree}
            onRenameWorktreeBranch={onRenameWorktreeBranch}
            onPrefetchWorktree={onPrefetchWorktree}
          />
        </div>

        <div className="shrink-0 border-t border-border/30 pt-2 pb-1 px-0">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
            onClick={onOpenSettings}
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      </aside>

      {/* ── Sidebar resize handle ── */}
      {isVisible ? (
        <div className="hidden relative w-0 lg:block" aria-hidden="true">
          <button
            type="button"
            className={`group absolute inset-y-0 -left-1.5 flex w-3 cursor-col-resize items-center justify-center transition-colors ${sidebarDragging ? "bg-primary/10" : ""
              }`}
            onMouseDown={handleSidebarMouseDown}
            aria-label="Resize sidebar"
          >
            <span
              className={`h-8 w-[2px] rounded-full transition-colors ${sidebarDragging ? "bg-primary/60" : "bg-border/30 group-hover:bg-primary/40"
                }`}
            />
          </button>
        </div>
      ) : null}
    </>
  );
});
