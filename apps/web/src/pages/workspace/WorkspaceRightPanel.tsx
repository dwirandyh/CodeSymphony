import { memo } from "react";
import { FolderTree, GitBranch, Smartphone } from "lucide-react";
import type { ReviewKind, ReviewRef } from "@codesymphony/shared-types";
import { DevicePanel } from "../../components/workspace/DevicePanel";
import { GitChangesPanel } from "../../components/workspace/GitChangesPanel";
import { WorkspaceExplorerPanel } from "../../components/workspace/WorkspaceExplorerPanel";
import { cn } from "../../lib/utils";
import { useSidebarResize } from "./hooks/useSidebarResize";
import type { useGitChanges } from "./hooks/useGitChanges";

type GitChangesData = ReturnType<typeof useGitChanges>;

export const WorkspaceRightPanel = memo(function WorkspaceRightPanel({
  desktopApp = false,
  rightPanelId,
  worktreeId,
  worktreePending = false,
  gitChanges,
  activeFilePath,
  selectedDiffFilePath,
  onOpenReview,
  onSelectDiffFile,
  onUpdatePanel,
  onOpenReadFile,
  reviewKind,
  reviewRef,
  prMrActionDisabled,
  prMrActionTitle,
  prMrActionBusy,
  onPrMrAction,
}: {
  desktopApp?: boolean;
  rightPanelId: "explorer" | "git" | "device" | null;
  worktreeId: string | null;
  worktreePending?: boolean;
  gitChanges: GitChangesData;
  activeFilePath: string | null;
  selectedDiffFilePath: string | null;
  onOpenReview: () => void;
  onSelectDiffFile: (filePath: string) => void;
  onUpdatePanel: (panel: "explorer" | "git" | "device" | undefined) => void;
  onOpenReadFile: (path: string) => void | Promise<void>;
  reviewKind?: ReviewKind | null;
  reviewRef?: ReviewRef | null;
  prMrActionDisabled?: boolean;
  prMrActionTitle?: string;
  prMrActionBusy?: boolean;
  onPrMrAction?: () => void;
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
        <div className={cn("relative w-0", desktopApp ? "block" : "hidden lg:block")} aria-hidden="true">
          <button
            type="button"
            className={cn(
              "group absolute inset-y-0 -left-1.5 z-40 flex w-3 cursor-col-resize items-center justify-center transition-colors",
              rightDragging && "bg-primary/10",
            )}
            onMouseDown={handleRightPanelMouseDown}
            aria-label="Resize right panel"
          >
            <span
              className={cn(
                "h-8 w-[2px] rounded-full transition-colors",
                rightDragging ? "bg-primary/60" : "bg-border/30 group-hover:bg-primary/40",
              )}
            />
          </button>
        </div>
      )}

      {/* ── Right Sidebar ── */}
      <div className={cn("mb-1 min-h-0 shrink-0 flex-row bg-card/75 sm:mb-2 lg:mb-0", desktopApp ? "flex" : "hidden lg:flex")}>
        {/* ── Right panel content ── */}
        {rightPanelId && (
          <aside
            ref={rightPanelRef}
            id="workspace-right-panel"
            aria-label={rightPanelId === "explorer" ? "Explorer panel" : rightPanelId === "git" ? "Source Control panel" : "Devices panel"}
            className="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border/30"
            style={{ width: `${rightPanelWidth}px` }}
          >
            {rightDragging ? (
              <div
                aria-hidden="true"
                data-resize-shield="true"
                className="absolute inset-0 z-30 cursor-col-resize bg-transparent"
              />
            ) : null}
            <div className={cn("flex min-h-0 flex-1 flex-col", rightDragging && "pointer-events-none select-none")}>
              {rightPanelId === "explorer" && (
                <WorkspaceExplorerPanel
                  worktreeId={worktreeId}
                  gitEntries={gitChanges.entries}
                  pending={worktreePending}
                  activeFilePath={activeFilePath}
                  onOpenFile={(path) => void onOpenReadFile(path)}
                  onClose={() => onUpdatePanel(undefined)}
                />
              )}
              {rightPanelId === "git" && (
                <GitChangesPanel
                  entries={gitChanges.entries}
                  branch={gitChanges.branch}
                  loading={gitChanges.loading}
                  committing={gitChanges.committing}
                  syncing={gitChanges.syncing}
                  canSync={gitChanges.canSync}
                  ahead={gitChanges.ahead}
                  behind={gitChanges.behind}
                  error={gitChanges.error}
                  selectedFilePath={selectedDiffFilePath}
                  onCommit={(msg) => void gitChanges.commit(msg)}
                  onSync={() => void gitChanges.sync()}
                  onReview={onOpenReview}
                  onRefresh={() => void gitChanges.refresh()}
                  onClose={() => onUpdatePanel(undefined)}
                  onSelectFile={onSelectDiffFile}
                  onDiscardChange={(path) => void gitChanges.discardChange(path)}
                  onOpenFile={(path) => void onOpenReadFile(path)}
                  reviewKind={reviewKind}
                  reviewRef={reviewRef}
                  prMrActionDisabled={prMrActionDisabled}
                  prMrActionTitle={prMrActionTitle}
                  prMrActionBusy={prMrActionBusy}
                  onPrMrAction={onPrMrAction}
                />
              )}
              {rightPanelId === "device" && (
                <DevicePanel
                  onClose={() => onUpdatePanel(undefined)}
                />
              )}
            </div>
          </aside>
        )}

        {/* ── Right icon bar ── */}
        <nav className={cn("flex w-[48px] shrink-0 flex-col items-center pt-[10px] lg:pt-[14px]", rightDragging && "pointer-events-none select-none")}>
          <button
            type="button"
            title="Explorer"
            aria-label="Explorer"
            aria-expanded={rightPanelId === "explorer"}
            aria-controls="workspace-right-panel"
            className={cn(
              "mb-2 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground",
              rightPanelId === "explorer" && "bg-secondary text-foreground",
            )}
            onClick={() => onUpdatePanel(rightPanelId === "explorer" ? undefined : "explorer")}
          >
            <FolderTree className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            title="Source Control"
            aria-label="Source Control"
            aria-expanded={rightPanelId === "git"}
            aria-controls="workspace-right-panel"
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
          <button
            type="button"
            title="Devices"
            aria-label="Devices"
            aria-expanded={rightPanelId === "device"}
            aria-controls="workspace-right-panel"
            className={cn(
              "mt-2 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground",
              rightPanelId === "device" && "bg-secondary text-foreground",
            )}
            onClick={() => onUpdatePanel(rightPanelId === "device" ? undefined : "device")}
          >
            <Smartphone className="h-[18px] w-[18px]" />
          </button>
        </nav>
      </div>
    </>
  );
});
