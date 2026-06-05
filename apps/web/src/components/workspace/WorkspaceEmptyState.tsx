import { useState } from "react";
import {
  ExternalLink,
  GitPullRequestArrow,
  MessageSquarePlus,
  PanelLeftOpen,
  Search,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import type { ReviewKind, ReviewRef } from "@codesymphony/shared-types";
import { useInstalledApps } from "../../hooks/queries/useInstalledApps";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { getWorkspaceShortcutLabel, WORKSPACE_SHORTCUTS, type WorkspaceShortcutId } from "./keyboardShortcuts";
import { resolvePreferredApp } from "./openInAppPreferences";

function CodesymphonyEmptyStateIcon({ className }: { className?: string }) {
  return (
    <img
      src="/brand/codesymphony-logo.png"
      alt=""
      data-testid="workspace-empty-state-logo"
      aria-hidden="true"
      draggable={false}
      className={cn("pointer-events-none object-contain", className)}
    />
  );
}

function KeyboardPill({ children }: { children: string }) {
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border/60 bg-background/70 px-1.5 text-[10px] font-medium leading-none text-muted-foreground/80 transition-colors group-hover:border-border group-hover:bg-secondary/80 group-hover:text-foreground">
      {children}
    </span>
  );
}

function KeyboardPillGroup({ label }: { label: string }) {
  return (
    <div className="ml-2 flex shrink-0 items-center gap-1.5">
      <KeyboardPill>{label}</KeyboardPill>
    </div>
  );
}

type ActionButtonProps = {
  label: string;
  shortcutId?: WorkspaceShortcutId;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
};

function EmptyStateActionButton({
  label,
  shortcutId,
  icon: Icon,
  onClick,
  disabled = false,
}: ActionButtonProps) {
  const shortcutLabel = shortcutId ? getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS[shortcutId]) : null;

  return (
    <button
      type="button"
      data-testid={`workspace-empty-state-action-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={cn(
        "group flex h-9 w-full items-center justify-between rounded-[6px] px-3 text-left text-sm text-muted-foreground/80 transition-colors hover:bg-secondary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-40",
        disabled && "cursor-not-allowed",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="rounded p-1 text-muted-foreground/90 transition-colors group-hover:text-foreground">
          <Icon className="h-4 w-4 stroke-[1.85]" />
        </span>
        <span className="truncate">{label}</span>
      </span>

      {shortcutLabel ? <KeyboardPillGroup label={shortcutLabel} /> : null}
    </button>
  );
}

type WorkspaceEmptyStateProps = {
  repositoryName: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  enableInstalledAppsQuery?: boolean;
  hasWorktree: boolean;
  worktreeReady: boolean;
  preparingThread: boolean;
  gitChangeCount: number;
  recentFilePaths: string[];
  reviewKind: ReviewKind | null;
  reviewRef: ReviewRef | null;
  canCreateThread: boolean;
  canOpenFiles: boolean;
  canCreateTerminal: boolean;
  canOpenCommitChanges: boolean;
  showRevealRepositoriesAction: boolean;
  onCreateThread: () => void;
  onOpenFilePicker: () => void;
  onCreateTerminal: () => void;
  onOpenCommitChanges: () => void;
  onOpenPullRequest: () => void;
  onRevealRepositories: () => void;
  onOpenRecentFile: (path: string) => void;
};

export function WorkspaceEmptyState({
  hasWorktree,
  worktreeReady,
  gitChangeCount,
  reviewKind,
  reviewRef,
  worktreePath,
  enableInstalledAppsQuery = true,
  canCreateThread,
  canOpenFiles,
  canCreateTerminal,
  canOpenCommitChanges,
  showRevealRepositoriesAction,
  onCreateThread,
  onOpenFilePicker,
  onCreateTerminal,
  onOpenCommitChanges,
  onOpenPullRequest,
  onRevealRepositories,
}: WorkspaceEmptyStateProps) {
  const { data: installedApps = [] } = useInstalledApps({
    enabled: enableInstalledAppsQuery,
  });
  const [openingApp, setOpeningApp] = useState(false);
  const workspaceReady = hasWorktree && worktreeReady;
  const selectedApp = worktreePath ? resolvePreferredApp(installedApps, worktreePath) : null;
  const openInAppLabel = selectedApp ? `Open in ${selectedApp.name}` : "Open in App";
  const showGitAction = reviewRef != null || (workspaceReady && canOpenCommitChanges && gitChangeCount > 0);
  const gitActionLabel = reviewRef
    ? reviewKind === "mr" ? "Open Merge Request" : "Open Pull Request"
    : "Commit Changes";

  async function handleOpenInApp() {
    if (!selectedApp || !worktreePath || openingApp) {
      return;
    }

    setOpeningApp(true);
    try {
      await api.openInApp({ appId: selectedApp.id, targetPath: worktreePath });
    } finally {
      setOpeningApp(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-1 items-center justify-center px-6 py-10">
      <div className="w-full max-w-xl -translate-y-4" data-testid="workspace-empty-state">
        <div className="mb-6 flex items-center justify-center py-1">
          <CodesymphonyEmptyStateIcon className="h-20 w-20 select-none" />
        </div>

        <div className="mx-auto grid w-full max-w-md gap-0.5">
          <EmptyStateActionButton
            label="New Thread"
            shortcutId="create_thread"
            icon={MessageSquarePlus}
            onClick={onCreateThread}
            disabled={!workspaceReady || !canCreateThread}
          />

          <EmptyStateActionButton
            label="New Terminal"
            shortcutId="create_terminal"
            icon={SquareTerminal}
            onClick={onCreateTerminal}
            disabled={!workspaceReady || !canCreateTerminal}
          />

          <EmptyStateActionButton
            label="Search Files"
            shortcutId="quick_file_picker"
            icon={Search}
            onClick={onOpenFilePicker}
            disabled={!workspaceReady || !canOpenFiles}
          />

          <EmptyStateActionButton
            label={openInAppLabel}
            shortcutId="open_in_app"
            icon={ExternalLink}
            onClick={() => {
              void handleOpenInApp();
            }}
            disabled={!workspaceReady || !worktreePath || !selectedApp || openingApp}
          />

          {showGitAction ? (
            <EmptyStateActionButton
              label={gitActionLabel}
              shortcutId={reviewRef ? "open_pull_request" : undefined}
              icon={GitPullRequestArrow}
              onClick={reviewRef ? onOpenPullRequest : onOpenCommitChanges}
            />
          ) : null}
        </div>

        {showRevealRepositoriesAction ? (
          <button
            type="button"
            data-testid="workspace-empty-state-show-repositories"
            className="mx-auto mt-6 flex items-center gap-1 text-xs text-muted-foreground/50 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            onClick={onRevealRepositories}
          >
            <PanelLeftOpen className="h-3 w-3 stroke-[1.85]" />
            Show repositories
          </button>
        ) : null}
      </div>
    </section>
  );
}
