import type { ComponentProps } from "react";
import { ArrowUp, ChevronDown, Plus, SlidersHorizontal, Zap } from "lucide-react";
import type { ChatThread, Repository } from "@codesymphony/shared-types";
import { StartupSplash } from "../components/startup/StartupSplash";
import { StartupStatusBanner } from "../components/startup/StartupStatusBanner";
import type { WorkspaceStartupRuntimeState } from "../components/startup/workspaceStartupState";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { WorkspaceEmptyState } from "../components/workspace/WorkspaceEmptyState";
import { WorkspaceHeader, type WorkspaceFileTab } from "../components/workspace/WorkspaceHeader";
import type { StartupShellSnapshot } from "../lib/startupShellSnapshot";
import { isTauriDesktop } from "../lib/openExternalUrl";
import { getWorkspaceHeaderContainerClassName, getWorkspaceMainClassName } from "./workspace/workspaceMainClass";
import { WorkspaceRightPanel } from "./workspace/WorkspaceRightPanel";
import { WorkspaceSidebar } from "./workspace/WorkspaceSidebar";
import type { WorkspaceSearch } from "../routes/index";

function labelFromPath(filePath: string | null | undefined): string {
  if (!filePath) {
    return "";
  }

  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

function resolveSelectedTabLabel(params: {
  activeView: WorkspaceSearch["view"] | undefined;
  filePath?: string;
  snapshot: StartupShellSnapshot;
}) {
  if (params.activeView === "file") {
    return labelFromPath(params.filePath) || "File";
  }

  if (params.activeView === "review") {
    return "Review Changes";
  }

  if (params.activeView === "automations") {
    return "Automations";
  }

  return params.snapshot.threadTitle ?? "Chat";
}

const FALLBACK_TIMESTAMP = "2026-05-21T00:00:00.000Z";
const FALLBACK_GIT_CHANGES: ComponentProps<typeof WorkspaceRightPanel>["gitChanges"] = {
  entries: [],
  branch: "",
  upstream: null,
  ahead: 0,
  behind: 0,
  canSync: false,
  connectionState: "healthy",
  loading: false,
  committing: false,
  syncing: false,
  error: null,
  commit: async () => {},
  sync: async () => {},
  discardChange: async () => {},
  getDiff: async () => ({ diff: "", summary: "" }),
  refresh: () => {},
};

function buildFallbackRepositories(snapshot: StartupShellSnapshot): Repository[] {
  const repositoriesFromSnapshot = snapshot.repositories?.map((repository) => ({
    id: repository.id,
    name: repository.name,
    rootPath: repository.rootPath,
    defaultBranch: repository.defaultBranch,
    createdAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
    updatedAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
    worktrees: repository.worktrees.map((worktree) => ({
      id: worktree.id,
      repositoryId: worktree.repositoryId,
      branch: worktree.branch,
      path: worktree.path,
      baseBranch: worktree.baseBranch,
      status: worktree.status,
      branchRenamed: worktree.branchRenamed,
      createdAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
      updatedAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
    })),
  })) ?? [];

  if (snapshot.repositories?.length) {
    if (!snapshot.repoId || repositoriesFromSnapshot.some((repository) => repository.id === snapshot.repoId)) {
      return repositoriesFromSnapshot;
    }
  }

  if (!snapshot.repoId || !snapshot.repoName) {
    return repositoriesFromSnapshot;
  }

  const hasWorktree = !!(
    snapshot.worktreeId
    || snapshot.worktreeBranch
    || snapshot.worktreePath
  );

  return [...repositoriesFromSnapshot, {
    id: snapshot.repoId,
    name: snapshot.repoName,
    rootPath: snapshot.worktreePath ?? snapshot.repoName,
    defaultBranch: snapshot.worktreeBranch ?? "main",
    createdAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
    updatedAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
    worktrees: hasWorktree ? [{
      id: snapshot.worktreeId ?? `${snapshot.repoId}-startup-worktree`,
      repositoryId: snapshot.repoId,
      branch: snapshot.worktreeBranch ?? "workspace",
      path: snapshot.worktreePath ?? snapshot.repoName,
      baseBranch: snapshot.worktreeBranch ?? "main",
      status: "active",
      branchRenamed: false,
      createdAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
      updatedAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
    }] : [],
  }];
}

function buildFallbackThreads(snapshot: StartupShellSnapshot): ChatThread[] {
  if (!snapshot.threadId || !snapshot.threadTitle) {
    return [];
  }

  return [{
    id: snapshot.threadId,
    worktreeId: snapshot.worktreeId ?? "startup-worktree",
    title: snapshot.threadTitle,
    kind: "default",
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: true,
    preferred: true,
    createdAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
    updatedAt: snapshot.capturedAt || FALLBACK_TIMESTAMP,
  }];
}

function buildFallbackFileTabs(filePath?: string): WorkspaceFileTab[] {
  if (!filePath) {
    return [];
  }

  return [{
    path: filePath,
    dirty: false,
    pinned: true,
  }];
}

function renderBottomPanelShell(snapshot: StartupShellSnapshot) {
  return (
    <div className="hidden lg:block">
      <BottomPanel
        worktreeId={snapshot.worktreeId}
        worktreePath={snapshot.worktreePath}
        selectedThreadId={snapshot.threadId}
        scriptOutputs={[]}
        activeTab="setup-script"
        collapsed={false}
        onTabChange={() => {}}
        onCollapsedChange={() => {}}
        runScriptActive={false}
        runScriptSessionId={null}
      />
    </div>
  );
}

function renderThreadShellBody(params: {
  runtimeState: WorkspaceStartupRuntimeState;
  selectedTabLabel: string;
}) {
  const composerPlaceholder = "Message CodeSymphony... (type / or $ for commands, @ to mention files)";

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1">
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <div className="h-full overflow-auto">
                <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-3 py-4">
                  <div className="flex-1" />
                  <div className="pb-3 text-xs text-muted-foreground">
                    {params.runtimeState === "reconnecting" || params.runtimeState === "offline"
                      ? "Reconnecting to your recent messages."
                      : `${params.selectedTabLabel} is restoring from local workspace state.`}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="pb-1 pt-0.5 safe-bottom lg:pb-2 lg:pt-1">
        <div className="mx-auto w-full max-w-3xl">
          <div className="relative rounded-2xl border border-input/50 bg-background/35 px-3 pb-11 pt-2.5 shadow-sm backdrop-blur-sm lg:rounded-3xl lg:px-4 lg:pb-12 lg:pt-3">
            <div
              role="textbox"
              aria-multiline="true"
              aria-readonly="true"
              aria-placeholder={composerPlaceholder}
              data-placeholder={composerPlaceholder}
              className="min-h-[60px] max-h-[140px] w-full overflow-y-auto resize-none border-none bg-transparent p-0 text-sm text-foreground shadow-none outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] md:min-h-[74px] md:max-h-[400px]"
            />

            <div className="absolute bottom-2 left-2.5 right-12 flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:bottom-3 lg:left-3 lg:right-auto lg:overflow-visible">
              <button
                type="button"
                disabled
                className="flex items-center justify-center rounded-full bg-secondary/60 p-1.5 text-muted-foreground opacity-80"
                aria-label="Attach files"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled
                className="flex items-center gap-1.5 rounded-full bg-secondary/60 px-2.5 py-1 text-xs font-medium text-muted-foreground opacity-80"
                aria-label="Switch to plan mode"
              >
                <Zap className="h-3 w-3" />
                Execute
              </button>
              <button
                type="button"
                disabled
                className="flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium text-muted-foreground opacity-80"
                aria-label="Select permission mode"
              >
                <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[160px] truncate">Default</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>
            </div>

            <div className="absolute bottom-2 right-2.5 flex items-center gap-2 lg:bottom-3 lg:right-3">
              <button
                type="button"
                disabled
                aria-label="Send message"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-black opacity-90"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function renderFileShellBody(filePath?: string) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/30 bg-card/55">
      <div className="flex items-center gap-2 border-b border-border/25 px-3 py-2">
        <div className="rounded-md border border-border/30 bg-background/60 px-2 py-1 text-[11px] font-medium text-foreground/85">
          {labelFromPath(filePath) || "File"}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {filePath || "Restoring file view"}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[#0f1218]">
        <div className="hidden w-12 shrink-0 border-r border-white/5 bg-[#0c1016] sm:block" />
        <div className="flex-1 bg-[linear-gradient(180deg,rgba(255,255,255,0.015),rgba(255,255,255,0))]" />
      </div>
    </section>
  );
}

function renderSurfaceShellBody(params: {
  activeView: "review" | "automations";
  selectedTabLabel: string;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/30 bg-card/55">
      <div className="flex items-center justify-between gap-2 border-b border-border/25 px-3 py-2">
        <div className="text-[11px] font-medium text-foreground/85">
          {params.selectedTabLabel}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {params.activeView === "review" ? "Preparing review data" : "Preparing automations"}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-background/15">
        <div className="flex items-center gap-2 border-b border-border/20 px-3 py-2">
          <span className="rounded-md bg-secondary/65 px-2 py-1 text-[11px] text-foreground/85">
            {params.activeView === "review" ? "Diff" : "Runs"}
          </span>
          <span className="rounded-md px-2 py-1 text-[11px] text-muted-foreground">
            {params.activeView === "review" ? "Summary" : "Schedule"}
          </span>
        </div>
        <div className="min-h-0 flex-1 bg-background/10" />
      </div>
    </section>
  );
}

function renderShellBody(params: {
  activeView: WorkspaceSearch["view"] | undefined;
  filePath?: string;
  runtimeState: WorkspaceStartupRuntimeState;
  snapshot: StartupShellSnapshot;
  selectedTabLabel: string;
}) {
  if (params.activeView === "file") {
    return renderFileShellBody(params.filePath);
  }

  if (params.activeView === "review" || params.activeView === "automations") {
    return renderSurfaceShellBody({
      activeView: params.activeView,
      selectedTabLabel: params.selectedTabLabel,
    });
  }

  if (!params.snapshot.threadId) {
    return (
      <WorkspaceEmptyState
        repositoryName={params.snapshot.repoName}
        worktreeBranch={params.snapshot.worktreeBranch}
        worktreePath={params.snapshot.worktreePath}
        enableInstalledAppsQuery={false}
        hasWorktree={!!params.snapshot.worktreeId}
        worktreeReady={!!params.snapshot.worktreeId}
        preparingThread={false}
        gitChangeCount={0}
        recentFilePaths={[]}
        reviewKind={null}
        reviewRef={null}
        canCreateThread={false}
        canOpenFiles={false}
        canCreateTerminal={false}
        canOpenCommitChanges={false}
        showRevealRepositoriesAction={false}
        onCreateThread={() => {}}
        onOpenFilePicker={() => {}}
        onCreateTerminal={() => {}}
        onOpenCommitChanges={() => {}}
        onOpenPullRequest={() => {}}
        onRevealRepositories={() => {}}
        onOpenRecentFile={() => {}}
      />
    );
  }

  return renderThreadShellBody({
    runtimeState: params.runtimeState,
    selectedTabLabel: params.selectedTabLabel,
  });
}

export function WorkspacePageShellFallback({
  activeView,
  filePath,
  panel,
  runtimeState,
  snapshot,
}: {
  activeView: WorkspaceSearch["view"] | undefined;
  filePath?: string;
  panel: WorkspaceSearch["panel"] | undefined;
  runtimeState: WorkspaceStartupRuntimeState;
  snapshot: StartupShellSnapshot | null;
}) {
  if (!snapshot) {
    return (
      <StartupSplash
        headline="Loading Workspace"
        detail="Preparing the editor, repositories, and terminal surfaces."
      />
    );
  }

  const desktopApp = isTauriDesktop();
  const repositories = buildFallbackRepositories(snapshot);
  const threads = buildFallbackThreads(snapshot);
  const fileTabs = buildFallbackFileTabs(filePath);
  const expandedRepositoryIds = snapshot.expandedRepositoryIds ?? (snapshot.repoId ? [snapshot.repoId] : []);
  const selectedTabLabel = resolveSelectedTabLabel({
    activeView,
    filePath,
    snapshot,
  });

  return (
    <div className="h-full min-h-screen bg-background text-foreground">
      <div className="flex h-full min-h-screen min-w-0 flex-col lg:flex-row">
        <WorkspaceSidebar
          desktopApp={desktopApp}
          repositories={repositories}
          selectedRepositoryId={snapshot.repoId}
          selectedWorktreeId={snapshot.worktreeId}
          hiddenRepositoryIds={snapshot.hiddenRepositoryIds ?? []}
          expandedByRepo={Object.fromEntries(expandedRepositoryIds.map((repositoryId) => [repositoryId, true]))}
          loadingRepos={false}
          submittingRepo={false}
          submittingWorktree={false}
          automationActive={activeView === "automations"}
          enableRepositoryMetadata={false}
          isVisible
          onOpenAutomations={() => {}}
          onOpenSettings={() => {}}
          onAttachRepository={() => {}}
          onSelectRepository={() => {}}
          onToggleRepositoryExpand={() => {}}
          onSetRepositoryVisibility={() => {}}
          onShowAllRepositories={() => {}}
          onReorderRepositories={() => {}}
          onCreateWorktree={() => {}}
          onSelectWorktree={() => {}}
          onDeleteWorktree={() => {}}
          onRenameWorktreeBranch={() => {}}
        />

        <main
          className={getWorkspaceMainClassName({
            activeView: activeView ?? "chat",
            mobileReposOverlayOpen: false,
          })}
        >
          <div className={getWorkspaceHeaderContainerClassName({ activeView: activeView ?? "chat" })}>
            <WorkspaceHeader
              desktopApp={desktopApp}
              selectedWorktreeBranch={snapshot.worktreeBranch}
              worktreePath={snapshot.worktreePath}
              enableInstalledAppsQuery={false}
              threads={threads}
              selectedThreadId={snapshot.threadId}
              fileTabs={fileTabs}
              activeFilePath={activeView === "file" ? filePath ?? null : null}
              disabled={false}
              createThreadDisabled={false}
              createTerminalDisabled={false}
              closingThreadId={null}
              showReviewTab={activeView === "review"}
              reviewTabActive={activeView === "review"}
              onSelectThread={() => {}}
              onSelectFileTab={() => {}}
              onPinFileTab={() => {}}
              onCloseFileTab={() => {}}
              onCreateThread={() => {}}
              onCreateTerminal={() => {}}
              onCloseThread={() => {}}
              onRenameThread={() => {}}
              onSelectReviewTab={() => {}}
              onCloseReviewTab={() => {}}
              runScriptRunning={false}
              onToggleRunScript={() => {}}
              leftPanelVisible
              onToggleLeftPanel={() => {}}
            />
            <StartupStatusBanner
              runtimeState={runtimeState}
              snapshot={snapshot}
              className="mx-1.5 mb-3 mt-2 sm:mx-2.5 lg:mx-3"
            />
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-0">
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-1.5 pb-0 sm:px-2.5 lg:px-3">
              {renderShellBody({
                activeView,
                filePath,
                runtimeState,
                snapshot,
                selectedTabLabel,
              })}
            </section>

            {renderBottomPanelShell(snapshot)}
          </div>
        </main>

        <WorkspaceRightPanel
          desktopApp={desktopApp}
          rightPanelId={panel ?? null}
          worktreeId={snapshot.worktreeId}
          worktreePending={false}
          gitChanges={FALLBACK_GIT_CHANGES}
          activeFilePath={activeView === "file" ? filePath ?? null : null}
          selectedDiffFilePath={null}
          onOpenReview={() => {}}
          onSelectDiffFile={() => {}}
          onUpdatePanel={() => {}}
          onOpenReadFile={() => {}}
        />
      </div>
    </div>
  );
}
