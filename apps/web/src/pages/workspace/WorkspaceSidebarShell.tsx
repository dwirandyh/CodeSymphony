import { cn } from "../../lib/utils";

export function WorkspaceSidebarShell({
  desktopApp = false,
  repositoryName,
  worktreeBranch,
  selectedIsRootWorkspace = false,
  isVisible = true,
}: {
  desktopApp?: boolean;
  repositoryName: string | null;
  worktreeBranch: string | null;
  selectedIsRootWorkspace?: boolean;
  isVisible?: boolean;
}) {
  if (!isVisible) {
    return null;
  }

  return (
    <aside
      className={cn(
        "mb-1 min-h-0 shrink-0 flex-col overflow-hidden bg-card/75 p-2 sm:mb-2 lg:mb-0 lg:p-3",
        desktopApp ? "flex" : "hidden lg:flex",
      )}
      style={{ width: "300px" }}
      data-testid="workspace-sidebar-shell"
    >
      <div className="mb-3">
        <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
        <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
      </div>

      <div className="min-h-0 flex-1 rounded-md border border-dashed border-border/40 bg-background/35 px-3 py-3">
        <p className="truncate text-xs font-medium text-foreground">
          {repositoryName ?? "Loading workspace"}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {selectedIsRootWorkspace ? "Root workspace" : worktreeBranch ?? "Loading repositories..."}
        </p>
      </div>

      <div className="shrink-0 border-t border-border/30 pt-2 pb-1 px-0">
        <div className="rounded-md px-2 py-1.5 text-xs text-muted-foreground">
          Loading repositories...
        </div>
      </div>
    </aside>
  );
}
