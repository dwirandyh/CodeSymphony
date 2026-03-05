import { memo } from "react";
import { GitBranch } from "lucide-react";
import { GitChangesPanel } from "../../components/workspace/GitChangesPanel";
import { cn } from "../../lib/utils";
import { useSidebarResize } from "./hooks/useSidebarResize";
import type { useGitChanges } from "./hooks/useGitChanges";

type GitChangesData = ReturnType<typeof useGitChanges>;

export const WorkspaceRightPanel = memo(function WorkspaceRightPanel({
  rightPanelId,
  gitChanges,
  selectedDiffFilePath,
  onOpenReview,
  onSelectDiffFile,
  onUpdatePanel,
  onOpenReadFile,
}: {
  rightPanelId: string | null;
  gitChanges: GitChangesData;
  selectedDiffFilePath: string | null;
  onOpenReview: () => void;
  onSelectDiffFile: (filePath: string) => void;
  onUpdatePanel: (panel: "git" | undefined) => void;
  onOpenReadFile: (path: string) => void | Promise<void>;
}) {
  const {
    sidebarWidth: rightPanelWidth,
    sidebarDragging: rightDragging,
    handleSidebarMouseDown: handleRightPanelMouseDown,
    panelRef: rightPanelRef,
  } = useSidebarResize(320, true);

  return (
    <>
      {/* ── Right panel resize handle ── */}
      {rightPanelId && (
        <div
          className={cn(
            "hidden w-1 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/20 lg:flex",
            rightDragging && "bg-primary/30",
          )}
          onMouseDown={handleRightPanelMouseDown}
        >
          <div
            className={cn(
              "h-8 w-[2px] rounded-full transition-colors",
              rightDragging ? "bg-primary/60" : "bg-border/30",
            )}
          />
        </div>
      )}

      {/* ── Right Sidebar ── */}
      <div className="mb-1 hidden min-h-0 shrink-0 flex-row rounded-2xl bg-card/75 sm:mb-2 lg:mb-3 lg:flex">
        {/* ── Right panel content ── */}
        {rightPanelId && (
          <aside
            ref={rightPanelRef}
            id="source-control-panel"
            aria-label="Source Control panel"
            className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border/30"
            style={{ width: `${rightPanelWidth}px` }}
          >
            {rightPanelId === "git" && (
              <GitChangesPanel
                entries={gitChanges.entries}
                branch={gitChanges.branch}
                loading={gitChanges.loading}
                committing={gitChanges.committing}
                error={gitChanges.error}
                selectedFilePath={selectedDiffFilePath}
                onCommit={(msg) => void gitChanges.commit(msg)}
                onReview={onOpenReview}
                onRefresh={() => void gitChanges.refresh()}
                onClose={() => onUpdatePanel(undefined)}
                onSelectFile={onSelectDiffFile}
                onDiscardChange={(path) => void gitChanges.discardChange(path)}
                onOpenFile={(path) => void onOpenReadFile(path)}
              />
            )}
          </aside>
        )}

        {/* ── Right icon bar ── */}
        <nav className="flex w-[48px] shrink-0 flex-col items-center pt-[10px] lg:pt-[14px]">
          <button
            type="button"
            title="Source Control"
            aria-label="Source Control"
            aria-expanded={rightPanelId === "git"}
            aria-controls="source-control-panel"
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground",
              rightPanelId === "git" && "bg-secondary text-foreground",
            )}
            onClick={() => onUpdatePanel(rightPanelId === "git" ? undefined : "git")}
          >
            <GitBranch className="h-[18px] w-[18px]" />
            {gitChanges.entries.length > 0 && (
              <span className="absolute right-0.5 top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
                {gitChanges.entries.length > 99 ? "99+" : gitChanges.entries.length}
              </span>
            )}
          </button>
        </nav>
      </div>
    </>
  );
});
