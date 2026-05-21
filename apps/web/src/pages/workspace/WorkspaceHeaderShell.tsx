import { cn } from "../../lib/utils";

export function WorkspaceHeaderShell({
  desktopApp = false,
  selectedWorktreeBranch,
  selectedIsRootWorkspace = false,
  targetBranch,
  selectedTabLabel,
  leftPanelVisible = true,
  onToggleLeftPanel,
}: {
  desktopApp?: boolean;
  selectedWorktreeBranch: string | null;
  selectedIsRootWorkspace?: boolean;
  targetBranch?: string | null;
  selectedTabLabel: string;
  leftPanelVisible?: boolean;
  onToggleLeftPanel?: () => void;
}) {
  const branchContextLabel = selectedWorktreeBranch
    ?? (selectedIsRootWorkspace ? "Root worktree" : "Worktree");
  const targetBranchLabel = targetBranch ? `origin/${targetBranch}` : "Select target branch";
  const resolvedSelectedTabLabel = selectedTabLabel.trim() || "Chat";

  return (
    <section
      className="workspace-header space-y-1 lg:space-y-1.5"
      data-testid="workspace-header-shell-fallback"
    >
      <div
        className={cn(
          "items-center justify-between gap-3",
          desktopApp ? "flex" : "hidden lg:flex",
        )}
        data-testid="workspace-header-shell-desktop-bar"
      >
        <div className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
          {onToggleLeftPanel ? (
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
              onClick={onToggleLeftPanel}
              aria-label={leftPanelVisible ? "Hide left panel" : "Show left panel"}
              title={leftPanelVisible ? "Hide left panel" : "Show left panel"}
            >
              {leftPanelVisible ? "Hide" : "Show"}
            </button>
          ) : null}

          <span className="min-w-0 truncate font-medium text-foreground/90">{branchContextLabel}</span>
          <span className="truncate text-foreground/70">{targetBranchLabel}</span>
        </div>

        <div
          className="h-8 w-16 shrink-0 rounded-md border border-border/35 bg-secondary/30"
          aria-hidden="true"
        />
      </div>

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 rounded-md border border-border/30 bg-background/45 px-2 py-1.5 text-xs font-medium text-foreground/90">
          <span className="block truncate">{resolvedSelectedTabLabel}</span>
        </div>
        <div
          className="h-8 w-8 shrink-0 rounded-md border border-border/35 bg-secondary/30"
          aria-hidden="true"
        />
      </div>
    </section>
  );
}
