import { StartupSplash } from "../components/startup/StartupSplash";
import { StartupStatusBanner } from "../components/startup/StartupStatusBanner";
import type { WorkspaceStartupRuntimeState } from "../components/startup/workspaceStartupState";
import type { StartupShellSnapshot } from "../lib/startupShellSnapshot";
import { isTauriDesktop } from "../lib/openExternalUrl";
import { getWorkspaceHeaderContainerClassName, getWorkspaceMainClassName } from "./workspace/workspaceMainClass";
import { WorkspaceHeaderShell } from "./workspace/WorkspaceHeaderShell";
import { WorkspaceRightPanelShell } from "./workspace/WorkspaceRightPanelShell";
import { WorkspaceSidebarShell } from "./workspace/WorkspaceSidebarShell";
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
  const selectedTabLabel = resolveSelectedTabLabel({
    activeView,
    filePath,
    snapshot,
  });

  return (
    <div className="h-full min-h-screen bg-background text-foreground">
      <div className="flex h-full min-h-screen min-w-0 flex-col lg:flex-row">
        <WorkspaceSidebarShell
          desktopApp={desktopApp}
          repositoryName={snapshot.repoName}
          worktreeBranch={snapshot.worktreeBranch}
          isVisible
        />

        <main
          className={getWorkspaceMainClassName({
            activeView: activeView ?? "chat",
            mobileReposOverlayOpen: false,
          })}
        >
          <div className={getWorkspaceHeaderContainerClassName({ activeView: activeView ?? "chat" })}>
            <WorkspaceHeaderShell
              desktopApp={desktopApp}
              selectedWorktreeBranch={snapshot.worktreeBranch}
              selectedTabLabel={selectedTabLabel}
            />
            <StartupStatusBanner
              runtimeState={runtimeState}
              snapshot={snapshot}
              className="mx-1.5 mb-3 mt-2 sm:mx-2.5 lg:mx-3"
            />
          </div>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
              Loading workspace shell...
            </div>
          </section>
        </main>

        <WorkspaceRightPanelShell
          desktopApp={desktopApp}
          rightPanelId={panel ?? null}
          gitChangeCount={0}
          onUpdatePanel={() => {}}
        />
      </div>
    </div>
  );
}
