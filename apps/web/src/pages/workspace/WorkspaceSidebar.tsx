import { memo } from "react";
import { Settings } from "lucide-react";
import type { Repository } from "@codesymphony/shared-types";
import { RepositoryPanel } from "../../components/workspace/RepositoryPanel";
import { useSidebarResize } from "./hooks/useSidebarResize";
import type { useRepositoryManager } from "./hooks/useRepositoryManager";
import type { RepositoryPanelDropPosition } from "./repositoryPanelPreferences";

type RepoManager = ReturnType<typeof useRepositoryManager>;

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  repos,
  orderedRepositories,
  hiddenRepositoryIds,
  expandedByRepo,
  onOpenSettings,
  onSelectRepository,
  onToggleRepositoryExpand,
  onSetRepositoryVisibility,
  onShowAllRepositories,
  onReorderRepositories,
  onSelectWorktree,
}: {
  repos: RepoManager;
  orderedRepositories: Repository[];
  hiddenRepositoryIds: string[];
  expandedByRepo: Record<string, boolean>;
  onOpenSettings: () => void;
  onSelectRepository: (repositoryId: string) => void;
  onToggleRepositoryExpand: (repositoryId: string, nextExpanded: boolean) => void;
  onSetRepositoryVisibility: (repositoryId: string, visible: boolean) => void;
  onShowAllRepositories: () => void;
  onReorderRepositories: (draggedRepositoryId: string, targetRepositoryId: string, position: RepositoryPanelDropPosition) => void;
  onSelectWorktree: (repositoryId: string, worktreeId: string, preferredThreadId?: string | null) => void;
}) {
  const { sidebarWidth, sidebarDragging, handleSidebarMouseDown, panelRef } = useSidebarResize(300);

  return (
    <>
      <aside
        ref={panelRef}
        className="mb-1 hidden min-h-0 shrink-0 flex-col overflow-hidden bg-card/75 p-2 sm:mb-2 lg:mb-0 lg:flex lg:p-3"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="mb-3">
          <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
          <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <RepositoryPanel
            repositories={orderedRepositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            selectedWorktreeId={repos.selectedWorktreeId}
            hiddenRepositoryIds={hiddenRepositoryIds}
            expandedByRepo={expandedByRepo}
            loadingRepos={repos.loadingRepos}
            submittingRepo={repos.submittingRepo}
            submittingWorktree={repos.submittingWorktree}
            onAttachRepository={repos.openFileBrowser}
            onSelectRepository={onSelectRepository}
            onToggleRepositoryExpand={onToggleRepositoryExpand}
            onSetRepositoryVisibility={onSetRepositoryVisibility}
            onShowAllRepositories={onShowAllRepositories}
            onReorderRepositories={onReorderRepositories}
            onCreateWorktree={(repositoryId) => void repos.submitWorktree(repositoryId)}
            onSelectWorktree={onSelectWorktree}
            onDeleteWorktree={(worktreeId) => void repos.removeWorktree(worktreeId)}
            onRenameWorktreeBranch={(worktreeId, newBranch) => void repos.renameWorktreeBranch(worktreeId, newBranch)}
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
    </>
  );
});
