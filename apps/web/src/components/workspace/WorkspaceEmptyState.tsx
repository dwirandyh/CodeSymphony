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
import { resolvePreferredApp } from "./openInAppPreferences";

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return true;
  }

  const platform = navigator.platform || navigator.userAgent || "";
  return /mac/i.test(platform);
}

function CodesymphonyEmptyStateIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 96 96"
      aria-hidden="true"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M48 6L78.3 23.5V72.5L48 90L17.7 72.5V23.5L48 6Z"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <path
        d="M48 15L70.5 28V68L48 81L25.5 68V28L48 15Z"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinejoin="round"
        opacity="0.8"
      />
      <path
        d="M28.5 37.5C24.2 37.5 22 39.7 22 44V47.5C22 49.8 20.9 51.4 18.8 52.2C20.9 53 22 54.6 22 56.9V60.4C22 64.7 24.2 66.9 28.5 66.9"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M67.5 37.5C71.8 37.5 74 39.7 74 44V47.5C74 49.8 75.1 51.4 77.2 52.2C75.1 53 74 54.6 74 56.9V60.4C74 64.7 71.8 66.9 67.5 66.9"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M36 68.5H31V78H36"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M60 68.5H65V78H60"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M50 16.5V69.5"
        stroke="currentColor"
        strokeWidth="3.75"
        strokeLinecap="round"
      />
      <path
        d="M50 18C42.7 19.1 37.5 25.6 37.5 33.1C37.5 41.2 43.6 47.5 51 47.5C57.5 47.5 62.5 42.3 62.5 35.7C62.5 27.3 56.1 20.5 48.1 20.5C38.2 20.5 30.5 28.9 30.5 39.4C30.5 52.2 39.5 61.9 50.6 61.9C59.2 61.9 66.1 55.2 66.1 46.8"
        stroke="currentColor"
        strokeWidth="3.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="39" cy="77" r="5" fill="currentColor" />
    </svg>
  );
}

function KeyboardPill({ children }: { children: string }) {
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border/60 bg-background/70 px-1.5 text-[10px] font-medium leading-none text-muted-foreground/80 transition-colors group-hover:border-border group-hover:bg-secondary/80 group-hover:text-foreground">
      {children}
    </span>
  );
}

function KeyboardPillGroup({ display }: { display: string[] }) {
  return (
    <div className="ml-2 flex shrink-0 items-center gap-1.5">
      {display.map((key) => (
        <KeyboardPill key={key}>{key}</KeyboardPill>
      ))}
    </div>
  );
}

type ActionButtonProps = {
  label: string;
  display: string[];
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
};

function EmptyStateActionButton({
  label,
  display,
  icon: Icon,
  onClick,
  disabled = false,
}: ActionButtonProps) {
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

      <KeyboardPillGroup display={display} />
    </button>
  );
}

type WorkspaceEmptyStateProps = {
  repositoryName: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
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
  const { data: installedApps = [] } = useInstalledApps();
  const [openingApp, setOpeningApp] = useState(false);
  const fileShortcut = isMacPlatform() ? ["Cmd", "Shift", "O"] : ["Ctrl", "Shift", "O"];
  const reviewShortcut = reviewKind === "mr" ? ["MR"] : ["PR"];
  const workspaceReady = hasWorktree && worktreeReady;
  const selectedApp = worktreePath ? resolvePreferredApp(installedApps, worktreePath) : null;
  const openInAppLabel = selectedApp ? `Open in ${selectedApp.name}` : "Open in App";
  const showGitAction = reviewRef != null || (workspaceReady && canOpenCommitChanges && gitChangeCount > 0);
  const gitActionLabel = reviewRef
    ? reviewKind === "mr" ? "Open Merge Request" : "Open Pull Request"
    : "Commit Changes";
  const gitActionDisplay = reviewRef ? (reviewKind === "mr" ? ["MR"] : ["PR"]) : ["GIT"];

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
      <div className="w-full max-w-xl" data-testid="workspace-empty-state">
        <div className="mb-6 flex items-center justify-center py-1">
          <CodesymphonyEmptyStateIcon className="h-14 w-14 select-none text-foreground/72" />
        </div>

        <div className="mx-auto grid w-full max-w-md gap-0.5">
          <EmptyStateActionButton
            label="New Terminal"
            display={["TERM"]}
            icon={SquareTerminal}
            onClick={onCreateTerminal}
            disabled={!workspaceReady || !canCreateTerminal}
          />

          <EmptyStateActionButton
            label="New Thread"
            display={["THREAD"]}
            icon={MessageSquarePlus}
            onClick={onCreateThread}
            disabled={!workspaceReady || !canCreateThread}
          />

          <EmptyStateActionButton
            label="Search Files"
            display={fileShortcut}
            icon={Search}
            onClick={onOpenFilePicker}
            disabled={!workspaceReady || !canOpenFiles}
          />

          <EmptyStateActionButton
            label={openInAppLabel}
            display={["APP"]}
            icon={ExternalLink}
            onClick={() => {
              void handleOpenInApp();
            }}
            disabled={!workspaceReady || !worktreePath || !selectedApp || openingApp}
          />

          {showGitAction ? (
            <EmptyStateActionButton
              label={gitActionLabel}
              display={gitActionDisplay}
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
