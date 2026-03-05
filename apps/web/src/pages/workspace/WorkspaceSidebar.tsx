import { memo } from "react";
import { Settings } from "lucide-react";
import { RepositoryPanel } from "../../components/workspace/RepositoryPanel";
import { useSidebarResize } from "./hooks/useSidebarResize";
import type { useRepositoryManager } from "./hooks/useRepositoryManager";

type RepoManager = ReturnType<typeof useRepositoryManager>;

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  repos,
  onOpenSettings,
  onSelectRepository,
}: {
  repos: RepoManager;
  onOpenSettings: () => void;
  onSelectRepository: (repositoryId: string) => void;
}) {
  const { sidebarWidth, sidebarDragging, handleSidebarMouseDown, panelRef } = useSidebarResize(300);

  return (
    <>
      <aside
        ref={panelRef}
        className="mb-1 hidden min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl bg-card/75 p-2 sm:mb-2 lg:mb-3 lg:flex lg:p-3"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="mb-3">
          <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
          <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <RepositoryPanel
            repositories={repos.repositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            selectedWorktreeId={repos.selectedWorktreeId}
            loadingRepos={repos.loadingRepos}
            submittingRepo={repos.submittingRepo}
            submittingWorktree={repos.submittingWorktree}
            onAttachRepository={repos.openFileBrowser}
            onSelectRepository={onSelectRepository}
            onCreateWorktree={(repositoryId) => void repos.submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId) => {
              repos.setSelectedRepositoryId(repositoryId);
              repos.setSelectedWorktreeId(worktreeId);
            }}
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
      <div
        className={`hidden w-1 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/20 lg:flex ${sidebarDragging ? "bg-primary/30" : ""
          }`}
        onMouseDown={handleSidebarMouseDown}
      >
        <div
          className={`h-8 w-[2px] rounded-full transition-colors ${sidebarDragging ? "bg-primary/60" : "bg-border/30"
            }`}
        />
      </div>
    </>
  );
});
