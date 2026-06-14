import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, Menu, Settings, X } from "lucide-react";
import {
  type ClaudeModelCatalogEntry,
  type ChatThread,
  type ReviewRef,
  type ReviewKind,
  type Repository,
  type Worktree,
} from "@codesymphony/shared-types";
import { Composer } from "../components/workspace/composer";
import { AGENT_LABELS } from "../components/workspace/composer/AgentModelSelector";
import { ChatMessageList } from "../components/workspace/chat-message-list";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { disposeTerminalRuntime } from "../components/workspace/terminalRuntimeRegistry";
const MobileRepositoryPanel = lazy(() =>
  import("../components/workspace/RepositoryPanel").then(m => ({ default: m.RepositoryPanel }))
);
const WorkspaceTerminalSurface = lazy(() =>
  import("../components/workspace/TerminalTab").then(m => ({ default: m.TerminalTab }))
);
const CodeEditorPanel = lazy(() =>
  import("../components/workspace/CodeEditorPanel").then(m => ({ default: m.CodeEditorPanel }))
);
const PermissionPromptCard = lazy(() =>
  import("../components/workspace/PermissionPromptCard").then(m => ({ default: m.PermissionPromptCard }))
);
const PlanDecisionComposer = lazy(() =>
  import("../components/workspace/PlanDecisionComposer").then(m => ({ default: m.PlanDecisionComposer }))
);
const QuestionCard = lazy(() =>
  import("../components/workspace/QuestionCard").then(m => ({ default: m.QuestionCard }))
);
const MacDesktopTitleBar = lazy(() =>
  import("../components/workspace/MacDesktopTitleBar").then(m => ({ default: m.MacDesktopTitleBar }))
);
import { WorkspaceEmptyState } from "../components/workspace/WorkspaceEmptyState";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { StartupStatusBanner } from "../components/startup/StartupStatusBanner";
import { useWorkspaceStartupState } from "../components/startup/workspaceStartupState";
const FileBrowserModal = lazy(() =>
  import("../components/workspace/FileBrowserModal").then(m => ({ default: m.FileBrowserModal }))
);
const SettingsDialog = lazy(() =>
  import("../components/workspace/SettingsDialog").then(m => ({ default: m.SettingsDialog }))
);
const IssueReportDialog = lazy(() =>
  import("../components/workspace/IssueReportDialog").then(m => ({ default: m.IssueReportDialog }))
);
const QuickFilePicker = lazy(() =>
  import("../components/workspace/QuickFilePicker").then(m => ({ default: m.QuickFilePicker }))
);
const LiveStatusErrorToast = lazy(() =>
  import("../components/workspace/LiveStatusErrorToast").then(m => ({ default: m.LiveStatusErrorToast }))
);
const ResourceMonitor = lazy(() =>
  import("../components/workspace/ResourceMonitor").then(m => ({ default: m.ResourceMonitor }))
);
const MobileActionBar = lazy(() =>
  import("../components/workspace/MobileActionBar").then(m => ({ default: m.MobileActionBar }))
);
const MobileFilesSheet = lazy(() =>
  import("../components/workspace/MobileWorkspaceNavigation").then(m => ({ default: m.MobileFilesSheet }))
);
const MobileGitSheet = lazy(() =>
  import("../components/workspace/MobileWorkspaceNavigation").then(m => ({ default: m.MobileGitSheet }))
);
const MobileMoreSheet = lazy(() =>
  import("../components/workspace/MobileWorkspaceNavigation").then(m => ({ default: m.MobileMoreSheet }))
);
const DevicePanel = lazy(() =>
  import("../components/workspace/DevicePanel").then(m => ({ default: m.DevicePanel }))
);
const MobileSavePill = lazy(() =>
  import("../components/workspace/MobileWorkspaceNavigation").then(m => ({ default: m.MobileSavePill }))
);
const MobileUtilitiesSheet = lazy(() =>
  import("../components/workspace/MobileWorkspaceNavigation").then(m => ({ default: m.MobileUtilitiesSheet }))
);
const loadWorkspaceAutomationsPanel = () =>
  import("./automations/AutomationsPage").then((m) => ({ default: m.WorkspaceAutomationsPanel }));
const WorkspaceAutomationsPanel = lazy(loadWorkspaceAutomationsPanel);
import { WorkspaceSidebar } from "./workspace/WorkspaceSidebar";
import { WorkspaceRightPanel } from "./workspace/WorkspaceRightPanel";
import {
  pruneSettledWorktreeStatusOverrides,
  reconcileWorktreeStatusOverrides,
} from "./workspace/worktreeStatusOverrides";
import {
  getJumpToWorktreeShortcutIndex,
  matchesCreateTerminalShortcut,
  matchesCreateThreadShortcut,
  matchesFocusChatInputShortcut,
  matchesNavigateBackShortcut,
  matchesNavigateForwardShortcut,
  matchesNextSessionTabShortcut,
  matchesNextWorktreeShortcut,
  matchesOpenInAppShortcut,
  matchesOpenPullRequestShortcut,
  matchesOpenSettingsShortcut,
  matchesPreviousSessionTabShortcut,
  matchesPreviousWorktreeShortcut,
  matchesToggleWorkspaceSidebarShortcut,
} from "../components/workspace/keyboardShortcuts";
import { resolvePreferredApp } from "../components/workspace/openInAppPreferences";
import type { ScriptOutputEntry } from "../components/workspace/ScriptOutputTab";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import {
  getWorkspaceHeaderContainerClassName,
  getWorkspaceMainClassName,
} from "./workspace/workspaceMainClass";
import {
  closeWorkspaceTerminalTab,
  getBottomPanelState,
  getTerminalTabsState,
  readPersistedWorkspaceTerminalUiState,
  reconcileWorkspaceTerminalTabs,
  restoreWorkspaceTerminalUiState,
  selectWorkspaceTerminalTab,
  type BottomPanelWorktreeState,
  type WorkspaceTerminalTabsState,
  writePersistedWorkspaceTerminalUiState,
} from "./workspace/workspaceTerminalPersistence";

const DiffReviewPanel = lazy(() =>
  import("../components/workspace/DiffReviewPanel").then(m => ({ default: m.DiffReviewPanel }))
);

const preloadCodeEditorPanel = () => import("../components/workspace/CodeEditorPanel");
const preloadDiffReviewPanel = () => import("../components/workspace/DiffReviewPanel");

import { api, type RuntimeInfo } from "../lib/api";
import { debugLog } from "../lib/debugLog";
import { isMacLikePlatform, loadGeneralSettings, saveGeneralSettings, type GeneralSettings } from "../lib/generalSettings";
import { scheduleWindowIdleTask } from "../lib/idleTask";
import {
  buildStartupShellRepositorySnapshots,
  buildStartupShellSnapshot,
  mergeStartupShellSnapshotInputFromFallback,
  resolveStartupShellFallbackState,
  resolveStartupWorkspaceSelection,
} from "../lib/startupShellSnapshot";
import { resolveWorkspaceLiveErrorSummary, type WorkspaceLiveStatusItem } from "../lib/workspaceLiveErrorState";
import {
  createWorkspaceLiveScopeSwitch,
  isUnavailableWorktreeErrorMessage,
  shouldKeepWorkspaceLiveScopeSwitch,
  WORKSPACE_LIVE_SCOPE_SWITCH_MAX_MS,
  type WorkspaceLiveScopeSelection,
  type WorkspaceLiveScopeSwitch,
} from "../lib/workspaceLiveBadgeState";
import { isDesktopShell, isElectronDesktop, openExternalUrl } from "../lib/openExternalUrl";
import {
  emitStartupSnapshotReadMetric,
  finalizeStartupBootstrapPayloadMetric,
  finalizeStartupBlankScreenMetric,
  isStartupRenderProfileEnabled,
  measureStartupMetricSinceBoot,
  trackStartupPersistedRead,
} from "../lib/startupPerf";
import { cn } from "../lib/utils";
import { isOptimisticThreadId } from "../lib/threadIds";
import {
  findRootWorktree,
  isOperationalWorktreeStatus,
  isPendingWorktreeStatus,
  isRootWorktree,
  isSelectableWorktreeStatus,
} from "../lib/worktree";
import { useRepositoryManager } from "./workspace/hooks/useRepositoryManager";
import type { ScriptUpdateEvent } from "./workspace/hooks/useRepositoryManager";
import { useChatSession } from "./workspace/hooks/chat-session";
import { usePendingGates } from "./workspace/hooks/usePendingGates";
import { useGitChanges } from "./workspace/hooks/useGitChanges";
import { useFileIndex } from "./workspace/hooks/useFileIndex";
import { useBackgroundWorktreeStatusStream } from "./workspace/hooks/useBackgroundWorktreeStatusStream";
import type { WorktreeStatusSummary } from "./workspace/hooks/worktreeThreadStatus";
import { useCompletionAttention } from "./workspace/hooks/useCompletionAttention";
import { useModelProviders } from "./workspace/hooks/useModelProviders";
import { useWorkspaceSyncStream } from "./workspace/hooks/useWorkspaceSyncStream";
import { subscribeToWorkspaceSyncSocket } from "../lib/workspaceLiveSocket";
import { useWorkspaceSearchParams } from "./workspace/hooks/useWorkspaceSearchParams";
import { useWorkspaceNavigationHistory } from "./workspace/hooks/useWorkspaceNavigationHistory";
import { useWorkspaceFileEditor } from "./workspace/hooks/useWorkspaceFileEditor";
import { shouldConfirmCloseThread } from "./workspace/closeThreadGuard";
import {
  hasStartupNonCriticalDataReadyState,
  hasStartupThreadShellReadyState,
  hasStartupWorkspaceShellReadyState,
} from "./workspace/startupShellReadiness";
import { shouldEagerlyEnableCriticalWorkspaceData } from "./workspace/startupCriticalData";
import { shouldScheduleWorkspacePanelPreload } from "./workspace/startupPanelPreload";
import { resolveMacCloseShortcutTarget } from "./workspace/threadCloseShortcut";
import {
  buildSessionShortcutCycleHistory,
  buildSessionShortcutTargets,
  getActiveSessionShortcutTarget,
  getActiveSessionShortcutTargetIndex,
  promoteSessionShortcutTarget,
  type SessionShortcutTarget,
} from "./workspace/sessionShortcutTargets";
import { shouldSuppressStartupFallbackSearchUpdate } from "./workspace/startupSelectionNavigation";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useRepositoryReviews } from "../hooks/queries/useRepositoryReviews";
import { useRepositoryBranches } from "../hooks/queries/useRepositoryBranches";
import { useCodexModels } from "../hooks/queries/useCodexModels";
import { useClaudeModels } from "../hooks/queries/useClaudeModels";
import { useRuntimeInfo } from "../hooks/queries/useRuntimeInfo";
import { useCursorModels } from "../hooks/queries/useCursorModels";
import { useOpencodeModels } from "../hooks/queries/useOpencodeModels";
import { useSlashCommandsQuery } from "../hooks/queries/useSlashCommandsQuery";
import { useInstalledApps } from "../hooks/queries/useInstalledApps";
import { THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS } from "../hooks/queries/useThreadSnapshot";
import { useThreadsByWorktreeIds, type ThreadsByWorktreeSnapshot } from "../hooks/queries/useThreads";
import { queryKeys } from "../lib/queryKeys";
import { startWorkspaceStartupBootstrap } from "../lib/workspaceStartupBootstrap";
import { refetchGitStatusCollection } from "../collections/gitStatus";
import { getThreadsCollection, replaceThreadsCollection } from "../collections/threads";
import { writeWorkspaceShellStateSnapshot } from "../collections/workspaceShellState";
import { buildRepositoryWorktreeIndex } from "../collections/worktrees";
import { useThreadThinkingActive } from "../collections/threadStreamState";
import { WorkspaceHeaderShell } from "./workspace/WorkspaceHeaderShell";
import { WorkspaceRightPanelShell } from "./workspace/WorkspaceRightPanelShell";
import { WorkspaceSidebarShell } from "./workspace/WorkspaceSidebarShell";
import {
  shouldClearPersistedStartupShell,
  shouldReleaseStartupSelectionFallback,
  shouldPreserveStartupThreadFallback,
} from "./workspace/startupShellPersistence";
import { buildPlanHandoffSearchPatch } from "./workspace/planHandoffNavigation";
import {
  shouldAutoLoadAllWorkspaceAgentCatalogs,
  shouldLoadWorkspaceAgentCatalog,
} from "./workspace/workspaceAgentCatalog";
import { isBaseBranchSelected, resolveReviewBaseBranch, resolveReviewBranch } from "./workspace/reviewBranch";
import {
  appendScriptOutputChunk,
  clearLifecycleScriptOutputs,
  upsertScriptOutputEntry,
} from "./workspace/scriptOutputState";

function resolveSelectedLatestReviewRef(input: {
  available: boolean | null | undefined;
  branchKey: string | null;
  reviewsByBranch: Record<string, ReviewRef> | null | undefined;
  worktreeSelected: boolean;
  worktreeUnavailable: boolean;
}): ReviewRef | null {
  if (!input.worktreeSelected || input.worktreeUnavailable || input.available !== true || !input.branchKey) {
    return null;
  }

  const reviewsByBranch = input.reviewsByBranch;
  if (!reviewsByBranch || typeof reviewsByBranch !== "object") {
    return null;
  }

  return reviewsByBranch[input.branchKey] ?? null;
}
import {
  loadRepositoryPanelPreferences,
  normalizeRepositoryPanelPreferences,
  reorderRepositoryIds,
  REPOSITORY_PANEL_PREFERENCES_STORAGE_KEY,
  sortRepositoriesByPreference,
  type RepositoryPanelDropPosition,
} from "./workspace/repositoryPanelPreferences";
import { filterRepositoriesForMetadataScope } from "./workspace/repositoryMetadataScope";
import {
  resolveUnavailableWorktreeSelection,
  resolveVisibleRepositorySelection,
} from "./workspace/visibleRepositorySelection";
import {
  buildInitialWorkspaceLandingHoldState,
  deriveVisibleUserGates,
  deriveWorkingStatus,
  FilledPauseIcon,
  FilledPlayIcon,
  resolveWorkspaceThreadlessFallbackSurface,
  shouldReturnToWorkspaceLandingAfterClosingContent,
  shouldShowThinkingPlaceholder,
  shouldShowWorkspaceEmptyState,
} from "./workspace/workspacePageUtils";
import {
  computeMobileKeyboardState,
  createMobileKeyboardBaseline,
  type MobileKeyboardBaseline,
} from "./workspace/mobileKeyboard";

function resolveRuntimePort(runtimeInfo: RuntimeInfo | null | undefined): number | null {
  if (runtimeInfo?.listenAddress?.kind === "tcp") {
    return runtimeInfo.listenAddress.port;
  }

  return runtimeInfo?.runtimePort ?? null;
}

function formatRuntimeLabel(runtimeInfo: RuntimeInfo | null | undefined): string | null {
  const port = resolveRuntimePort(runtimeInfo);
  if (port == null) {
    return null;
  }

  if (port === 4331) {
    return "Dev runtime :4331";
  }

  if (port === 4321) {
    return "Desktop dev runtime :4321";
  }

  if (port === 4322) {
    return "Desktop runtime :4322";
  }

  return `Runtime :${port}`;
}

type WorktreeShortcutTarget = {
  repositoryId: string;
  worktreeId: string;
};

function getWrappedIndex(currentIndex: number, length: number, direction: "previous" | "next"): number {
  if (length <= 0) {
    return -1;
  }

  if (currentIndex < 0) {
    return direction === "previous" ? length - 1 : 0;
  }

  return direction === "previous"
    ? (currentIndex - 1 + length) % length
    : (currentIndex + 1) % length;
}

function buildVisibleWorktreeShortcutTargets(input: {
  repositories: Repository[];
  expandedByRepo: Record<string, boolean>;
  selectedRepositoryId: string | null;
}): WorktreeShortcutTarget[] {
  return input.repositories.flatMap((repository) => {
    const isExpanded = input.expandedByRepo[repository.id] ?? input.selectedRepositoryId === repository.id;
    if (!isExpanded) {
      return [];
    }

    const rootWorktree = findRootWorktree(repository);
    const branchWorktrees = repository.worktrees.filter((worktree) => worktree.id !== rootWorktree?.id);
    const visibleWorktrees = rootWorktree
      ? [rootWorktree, ...branchWorktrees]
      : branchWorktrees;

    return visibleWorktrees
      .filter((worktree: Worktree) => isSelectableWorktreeStatus(worktree.status))
      .map((worktree) => ({
        repositoryId: repository.id,
        worktreeId: worktree.id,
      }));
  });
}

function formatRuntimeTitle(runtimeInfo: RuntimeInfo | null | undefined): string | null {
  if (!runtimeInfo) {
    return null;
  }

  const port = resolveRuntimePort(runtimeInfo);
  const lines = [
    port != null ? `Port: ${port}` : null,
    runtimeInfo.cwd ? `Runtime cwd: ${runtimeInfo.cwd}` : null,
    runtimeInfo.database.resolvedPath ? `Database: ${runtimeInfo.database.resolvedPath}` : runtimeInfo.database.urlPreview
      ? `Database: ${runtimeInfo.database.urlPreview}`
      : null,
  ].filter((line): line is string => typeof line === "string" && line.length > 0);

  return lines.length > 0 ? lines.join("\n") : null;
}

function isMacDesktopShell(): boolean {
  if (!isDesktopShell()) {
    return false;
  }

  if (isElectronDesktop()) {
    return true;
  }

  if (typeof navigator === "undefined") {
    return false;
  }

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform ?? "";

  return /mac/i.test(platform) || /mac os x/i.test(navigator.userAgent);
}

const REPOSITORY_PANEL_EXPANDED_STORAGE_KEY = "codesymphony:workspace:repository-panel-expanded";
const LEFT_SIDEBAR_VISIBLE_STORAGE_KEY = "codesymphony:workspace:left-sidebar-visible";
const MOBILE_KEYBOARD_OFFSET_CSS_VAR = "--cs-mobile-keyboard-offset";
type MobileInlinePanel = "files" | "git" | "more" | "utilities" | "device";
type MobilePanelState = "repos" | MobileInlinePanel | null;
type MobileReposOrigin = {
  panel: MobileInlinePanel | null;
  view: "chat" | "file" | "review" | "automations";
};

function labelFromPath(filePath: string | null | undefined): string {
  if (!filePath) {
    return "";
  }

  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

function resolveMobileWorktreeTarget(origin: MobileReposOrigin | null): MobileInlinePanel | null {
  if (!origin) {
    return null;
  }

  if (origin.panel) {
    return origin.panel;
  }

  if (origin.view === "file") {
    return "files";
  }

  if (origin.view === "review") {
    return "git";
  }

  return null;
}

function toDebugErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error == null) {
    return null;
  }

  return String(error);
}

function resolvePreferredThreadIdFromThreads(
  threads: ChatThread[],
  preferredThreadId?: string | null,
): string | null {
  type PreferredChatThread = ChatThread & { preferred?: boolean };

  function isPreferredThread(thread: ChatThread): thread is PreferredChatThread {
    return (thread as PreferredChatThread).preferred === true;
  }

  if (preferredThreadId && threads.some((thread) => thread.id === preferredThreadId)) {
    return preferredThreadId;
  }

  function pickMostRecentThread(candidates: ChatThread[]): ChatThread | null {
    let preferredThread: ChatThread | null = null;

    for (const thread of candidates) {
      if (!preferredThread) {
        preferredThread = thread;
        continue;
      }

      const threadUpdatedAt = Date.parse(thread.updatedAt);
      const preferredUpdatedAt = Date.parse(preferredThread.updatedAt);
      if (threadUpdatedAt > preferredUpdatedAt) {
        preferredThread = thread;
        continue;
      }

      if (threadUpdatedAt === preferredUpdatedAt) {
        const threadCreatedAt = Date.parse(thread.createdAt);
        const preferredCreatedAt = Date.parse(preferredThread.createdAt);
        if (threadCreatedAt > preferredCreatedAt) {
          preferredThread = thread;
        }
      }
    }

    return preferredThread;
  }

  const activeThreads = threads.filter((thread) => thread.active);
  const preferredActiveThread = pickMostRecentThread(activeThreads.filter(isPreferredThread));
  if (preferredActiveThread) {
    return preferredActiveThread.id;
  }

  const activeThread = pickMostRecentThread(activeThreads);
  if (activeThread) {
    return activeThread.id;
  }

  const preferredThread = pickMostRecentThread(threads.filter(isPreferredThread));
  if (preferredThread) {
    return preferredThread.id;
  }

  return pickMostRecentThread(threads)?.id ?? null;
}

function isDesktopViewportNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(min-width: 1024px)").matches;
}

function isWorkspaceShortcutEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return (
    target.isContentEditable
    || tagName === "input"
    || tagName === "textarea"
    || tagName === "select"
    || target.closest('[contenteditable="true"]') !== null
  );
}

function loadRepositoryPanelExpandedState(): Record<string, boolean> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(REPOSITORY_PANEL_EXPANDED_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function loadStoredBoolean(storageKey: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function BackgroundWorktreeStatusStreamBridge({
  repositories,
  selectedWorktreeId,
  selectedThreadId,
  threadSnapshot,
  onCompletionAttentionEvent,
}: {
  repositories: ReturnType<typeof useRepositoryManager>["repositories"];
  selectedWorktreeId: string | null;
  selectedThreadId: string | null;
  threadSnapshot: ThreadsByWorktreeSnapshot;
  onCompletionAttentionEvent?: Parameters<typeof useBackgroundWorktreeStatusStream>[4];
}) {
  useBackgroundWorktreeStatusStream(
    repositories,
    selectedWorktreeId,
    selectedThreadId,
    threadSnapshot,
    onCompletionAttentionEvent,
  );
  return null;
}

function WorkspaceSyncStreamBridge() {
  useWorkspaceSyncStream();
  return null;
}

export function WorkspacePage() {
  const startupRenderProfileEnabled = isStartupRenderProfileEnabled();
  const startupRenderProfileStartedAtMs = startupRenderProfileEnabled && typeof performance !== "undefined"
    ? performance.now()
    : 0;
  const startupRenderProfileSections: Array<{ label: string; elapsedMs: number }> = [];
  const pushStartupRenderProfileSection = (label: string) => {
    if (!startupRenderProfileEnabled || typeof performance === "undefined") {
      return;
    }

    startupRenderProfileSections.push({
      label,
      elapsedMs: Math.round((performance.now() - startupRenderProfileStartedAtMs) * 10) / 10,
    });
  };
  const [error, setError] = useState<string | null>(null);
  const [generalSettings, setGeneralSettings] = useState<GeneralSettings>(() =>
    trackStartupPersistedRead("workspace.general_settings", () => loadGeneralSettings()));
  const startupState = useWorkspaceStartupState();
  const [startupSelectionFallbackActive, setStartupSelectionFallbackActive] = useState(() => startupState.snapshot != null);
  const { search, updateSearch } = useWorkspaceSearchParams();
  const desktopApp = isDesktopShell();
  const restoredSelection = resolveStartupWorkspaceSelection({
    repoId: search.repoId,
    worktreeId: search.worktreeId,
    threadId: search.threadId,
    snapshot: startupSelectionFallbackActive ? startupState.snapshot : null,
  });
  const restoredRepoId = restoredSelection.repoId;
  const restoredWorktreeId = restoredSelection.worktreeId;
  const restoredThreadId = restoredSelection.threadId;

  const prevWorktreeIdRef = useRef<string | undefined>(restoredWorktreeId);
  const pendingWorktreeSearchSelectionRef = useRef<{
    repoId: string | null;
    worktreeId: string | null;
    threadId?: string;
  } | null>(null);
  const pendingDesiredSelection = pendingWorktreeSearchSelectionRef.current;
  const desiredChatWorktreeId = pendingDesiredSelection?.worktreeId ?? restoredWorktreeId ?? null;
  const desiredChatThreadId = pendingDesiredSelection?.threadId ?? restoredThreadId ?? undefined;

  useEffect(() => {
    const pendingSelection = pendingWorktreeSearchSelectionRef.current;
    if (!pendingSelection || !pendingSelection.worktreeId) {
      return;
    }

    const worktreeMatched = search.worktreeId === pendingSelection.worktreeId;
    const threadMatched = pendingSelection.threadId == null || search.threadId === pendingSelection.threadId;

    if (worktreeMatched && threadMatched) {
      pendingWorktreeSearchSelectionRef.current = null;
    }
  }, [search.threadId, search.worktreeId]);

  const [expandedByRepo, setExpandedByRepo] = useState<Record<string, boolean>>(() =>
    trackStartupPersistedRead("workspace.repository_panel_expanded", () => loadRepositoryPanelExpandedState()));
  const [repositoryPanelPreferences, setRepositoryPanelPreferences] = useState(() =>
    trackStartupPersistedRead("workspace.repository_panel_preferences", () => loadRepositoryPanelPreferences()));
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(() =>
    trackStartupPersistedRead("workspace.left_sidebar_visible", () => loadStoredBoolean(LEFT_SIDEBAR_VISIBLE_STORAGE_KEY, true)));
  const [scriptOutputs, setScriptOutputs] = useState<ScriptOutputEntry[]>([]);
  const [bottomPanelStateByWorktreeId, setBottomPanelStateByWorktreeId] = useState<Record<string, BottomPanelWorktreeState>>({});
  const [workspaceLandingHoldByWorktreeId, setWorkspaceLandingHoldByWorktreeId] = useState<Record<string, boolean>>(() =>
    buildInitialWorkspaceLandingHoldState({
      routeWorktreeId: search.worktreeId ?? null,
      routeThreadId: search.threadId ?? null,
    }),
  );
  const [enableCriticalWorkspaceData, setEnableCriticalWorkspaceData] = useState(() => desktopApp);
  const [enableNonCriticalWorkspaceData, setEnableNonCriticalWorkspaceData] = useState(false);
  const chatMessageListChunkReady = true;
  const workspaceLandingHoldByWorktreeIdRef = useRef<Record<string, boolean>>({});
  const workspacePanelsPreloadedRef = useRef(false);
  const showMacDesktopTitleBar = isMacDesktopShell();
  const setWorkspaceLandingHold = useCallback((worktreeId: string | null, hold: boolean) => {
    if (!worktreeId) {
      return;
    }

    setWorkspaceLandingHoldByWorktreeId((current) => {
      if (hold) {
        if (current[worktreeId] === true) {
          workspaceLandingHoldByWorktreeIdRef.current = current;
          return current;
        }

        const next = {
          ...current,
          [worktreeId]: true,
        };
        workspaceLandingHoldByWorktreeIdRef.current = next;
        return next;
      }

      if (current[worktreeId] !== true) {
        workspaceLandingHoldByWorktreeIdRef.current = current;
        return current;
      }

      const { [worktreeId]: _removed, ...rest } = current;
      workspaceLandingHoldByWorktreeIdRef.current = rest;
      return rest;
    });
  }, []);

  const {
    providers: modelProviders,
  } = useModelProviders({
    enabled: enableNonCriticalWorkspaceData,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(REPOSITORY_PANEL_EXPANDED_STORAGE_KEY, JSON.stringify(expandedByRepo));
  }, [expandedByRepo]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(REPOSITORY_PANEL_PREFERENCES_STORAGE_KEY, JSON.stringify(repositoryPanelPreferences));
  }, [repositoryPanelPreferences]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(LEFT_SIDEBAR_VISIBLE_STORAGE_KEY, JSON.stringify(leftSidebarVisible));
  }, [leftSidebarVisible]);

  const handleToggleLeftSidebar = useCallback(() => {
    setLeftSidebarVisible((current) => !current);
  }, []);
  const handleRevealRepositories = useCallback(() => {
    setLeftSidebarVisible(true);
  }, []);

  const updateBottomPanelState = useCallback((worktreeId: string | null | undefined, updater: (current: BottomPanelWorktreeState) => BottomPanelWorktreeState) => {
    if (!worktreeId) {
      return;
    }

    setBottomPanelStateByWorktreeId((prev) => ({
      ...prev,
      [worktreeId]: updater(getBottomPanelState(prev, worktreeId)),
    }));
  }, []);

  const updateTerminalTabsState = useCallback((worktreeId: string | null | undefined, updater: (current: WorkspaceTerminalTabsState) => WorkspaceTerminalTabsState) => {
    if (!worktreeId) {
      return;
    }

    setTerminalTabsByWorktreeId((prev) => ({
      ...prev,
      [worktreeId]: updater(getTerminalTabsState(prev, worktreeId)),
    }));
  }, []);

  const syncTerminalTabsFromServer = useCallback(async () => {
    let serverTabs;
    try {
      serverTabs = await api.listTerminalTabs();
    } catch {
      return;
    }

    const serverTabsByWorktreeId = new Map<string, typeof serverTabs>();
    for (const tab of serverTabs) {
      const existing = serverTabsByWorktreeId.get(tab.worktreeId);
      if (existing) {
        existing.push(tab);
      } else {
        serverTabsByWorktreeId.set(tab.worktreeId, [tab]);
      }
    }

    setTerminalTabsByWorktreeId((prev) => {
      const worktreeIds = new Set([...Object.keys(prev), ...serverTabsByWorktreeId.keys()]);
      let changed = false;
      const next: Record<string, WorkspaceTerminalTabsState> = {};

      for (const worktreeId of worktreeIds) {
        const current = getTerminalTabsState(prev, worktreeId);
        const reconciled = reconcileWorkspaceTerminalTabs({
          current,
          serverTabs: serverTabsByWorktreeId.get(worktreeId) ?? [],
        });
        next[worktreeId] = reconciled;
        if (reconciled !== prev[worktreeId]) {
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    void syncTerminalTabsFromServer();

    const unsubscribe = subscribeToWorkspaceSyncSocket({
      onEvent(event) {
        if (event.type === "terminal.tab.created" || event.type === "terminal.tab.updated" || event.type === "terminal.tab.closed") {
          void syncTerminalTabsFromServer();
        }
      },
    });

    return unsubscribe;
  }, [syncTerminalTabsFromServer]);

  const hideTerminalView = useCallback((worktreeId: string | null | undefined) => {
    if (!worktreeId) {
      return;
    }

    setTerminalTabsByWorktreeId((prev) => {
      const current = prev[worktreeId];
      if (!current || !current.visible) {
        return prev;
      }

      return {
        ...prev,
        [worktreeId]: {
          ...current,
          visible: false,
        },
      };
    });
  }, []);

  const resolveSaveAutomationTargetSessionId = useCallback((worktreeId: string) => {
    return getBottomPanelState(bottomPanelStateByWorktreeId, worktreeId).runScriptSessionId
      ?? `${worktreeId}:terminal`;
  }, [bottomPanelStateByWorktreeId]);

  const handleScriptUpdate = useCallback((event: ScriptUpdateEvent) => {
    setScriptOutputs((prev) => upsertScriptOutputEntry(prev, event));
    if (event.type === "run") {
      updateBottomPanelState(event.worktreeId, (current) => ({
        ...current,
        activeTab: "run",
        openSignal: current.openSignal + 1,
      }));
      return;
    }

    if (event.type === "setup" || event.type === "teardown") {
      updateBottomPanelState(event.worktreeId, (current) => ({
        ...current,
        activeTab: "setup-script",
        openSignal: current.openSignal + 1,
      }));
    }
  }, [updateBottomPanelState]);

  const handleScriptOutputChunk = useCallback(({ worktreeId, chunk }: { worktreeId: string; chunk: string }) => {
    setScriptOutputs((prev) => appendScriptOutputChunk(prev, { worktreeId, chunk }));
  }, []);

  const handleRunScriptTerminalExit = useCallback((event: { exitCode: number; signal: number }, targetWorktreeId: string | null) => {
    updateBottomPanelState(targetWorktreeId, (current) => ({
      ...current,
      runScriptActive: false,
    }));

    if (targetWorktreeId) {
      setScriptOutputs((prev) => prev.map((entry) =>
        entry.worktreeId === targetWorktreeId && entry.type === "run" && entry.status === "running"
          ? { ...entry, status: "completed", success: event.exitCode === 0 }
          : entry,
      ));
    }
  }, [updateBottomPanelState]);

  const repos = useRepositoryManager(setError, {
    desiredRepoId: restoredRepoId,
    desiredWorktreeId: restoredWorktreeId,
    preserveMissingDesiredWorktree: search.worktreeId === restoredWorktreeId,
    repositoriesEnabled: enableCriticalWorkspaceData,
    onScriptUpdate: handleScriptUpdate,
    onScriptOutputChunk: handleScriptOutputChunk,
    onSelectionChange: useCallback(
      (selection: { repoId: string | null; worktreeId: string | null }) => {
        const pendingSelection = pendingWorktreeSearchSelectionRef.current;
        debugLog("workspace.selection.navigation", "repository.onSelectionChange", {
          nextRepoId: selection.repoId,
          nextWorktreeId: selection.worktreeId,
          previousWorktreeId: prevWorktreeIdRef.current ?? null,
          routeRepoId: search.repoId ?? null,
          routeWorktreeId: search.worktreeId ?? null,
          routeThreadId: search.threadId ?? null,
          pendingRepoId: pendingSelection?.repoId ?? null,
          pendingWorktreeId: pendingSelection?.worktreeId ?? null,
          pendingThreadId: pendingSelection?.threadId ?? null,
          pendingSelectionMatches: pendingSelection?.repoId === selection.repoId
            && pendingSelection?.worktreeId === selection.worktreeId,
        }, { worktreeId: selection.worktreeId, force: true });

        const intendedRepoId = pendingSelection?.repoId ?? search.repoId ?? restoredRepoId ?? null;
        const intendedWorktreeId = pendingSelection?.worktreeId ?? search.worktreeId ?? restoredWorktreeId ?? null;
        const selectionLostIntendedWorkspace =
          (selection.repoId == null && intendedRepoId != null)
          || (selection.worktreeId == null && intendedWorktreeId != null);
        if (selectionLostIntendedWorkspace) {
          return;
        }

        if (
          pendingSelection?.repoId === selection.repoId
          && pendingSelection?.worktreeId === selection.worktreeId
        ) {
          prevWorktreeIdRef.current = selection.worktreeId ?? undefined;
          return;
        }

        const worktreeChanged = (selection.worktreeId ?? undefined) !== prevWorktreeIdRef.current;
        prevWorktreeIdRef.current = selection.worktreeId ?? undefined;
        const shouldReusePendingThreadId =
          pendingSelection?.worktreeId === selection.worktreeId;

        if (shouldSuppressStartupFallbackSearchUpdate({
          startupSelectionFallbackActive,
          routeRepoId: search.repoId ?? null,
          routeWorktreeId: search.worktreeId ?? null,
          pendingRepoId: pendingSelection?.repoId ?? null,
          pendingWorktreeId: pendingSelection?.worktreeId ?? null,
          restoredRepoId: restoredRepoId ?? null,
          restoredWorktreeId: restoredWorktreeId ?? null,
          nextRepoId: selection.repoId,
          nextWorktreeId: selection.worktreeId,
        })) {
          return;
        }

        const nextSearchPatch = {
          repoId: selection.repoId ?? undefined,
          worktreeId: selection.worktreeId ?? undefined,
          ...(shouldReusePendingThreadId
            ? { threadId: pendingSelection?.threadId }
            : worktreeChanged
              ? { threadId: undefined }
              : {}),
        };
        updateSearch(nextSearchPatch);
      },
      [restoredRepoId, restoredWorktreeId, search.repoId, search.threadId, search.worktreeId, startupSelectionFallbackActive, updateSearch],
    ),
  });
  const repositoriesLoadError = repos.repositoriesError instanceof Error
    ? repos.repositoriesError.message
    : null;
  pushStartupRenderProfileSection("repository-manager");
  const uiError = error ?? repositoriesLoadError;
  const normalizedRepositoryPanelPreferences = useMemo(
    () => normalizeRepositoryPanelPreferences(repos.repositories, repositoryPanelPreferences),
    [repos.repositories, repositoryPanelPreferences],
  );
  const orderedRepositories = useMemo(
    () => sortRepositoriesByPreference(repos.repositories, normalizedRepositoryPanelPreferences.order),
    [normalizedRepositoryPanelPreferences.order, repos.repositories],
  );
  const hiddenRepositoryIds = normalizedRepositoryPanelPreferences.hidden;
  const hiddenRepositoryIdSet = useMemo(() => new Set(hiddenRepositoryIds), [hiddenRepositoryIds]);
  const startupRepositorySnapshots = useMemo(
    () => buildStartupShellRepositorySnapshots(orderedRepositories),
    [orderedRepositories],
  );
  const snapshotExpandedRepositoryIds = useMemo(
    () => orderedRepositories
      .filter((repository) => expandedByRepo[repository.id] ?? repos.selectedRepositoryId === repository.id)
      .map((repository) => repository.id),
    [expandedByRepo, orderedRepositories, repos.selectedRepositoryId],
  );
  const visibleRepositories = useMemo(
    () => orderedRepositories.filter((repository) => !hiddenRepositoryIdSet.has(repository.id)),
    [hiddenRepositoryIdSet, orderedRepositories],
  );
  const visibleWorktreeShortcutTargets = useMemo(
    () => buildVisibleWorktreeShortcutTargets({
      repositories: visibleRepositories,
      expandedByRepo,
      selectedRepositoryId: repos.selectedRepositoryId,
    }),
    [expandedByRepo, repos.selectedRepositoryId, visibleRepositories],
  );
  const metadataScopedRepositories = useMemo(
    () => filterRepositoriesForMetadataScope({
      repositories: visibleRepositories,
      selectedRepositoryId: repos.selectedRepositoryId,
      expandedByRepo,
    }),
    [expandedByRepo, repos.selectedRepositoryId, visibleRepositories],
  );
  const desiredVisibleRepositoryId = useMemo(() => {
    if (search.worktreeId) {
      const matchedRepository = repos.repositories.find((repository) =>
        repository.worktrees.some((worktree) => worktree.id === search.worktreeId),
      );
      if (matchedRepository) {
        return matchedRepository.id;
      }
    }

    if (search.repoId && repos.repositories.some((repository) => repository.id === search.repoId)) {
      return search.repoId;
    }

    return null;
  }, [repos.repositories, search.repoId, search.worktreeId]);
  useEffect(() => {
    if (
      sameIds(normalizedRepositoryPanelPreferences.order, repositoryPanelPreferences.order)
      && sameIds(normalizedRepositoryPanelPreferences.hidden, repositoryPanelPreferences.hidden)
    ) {
      return;
    }

    setRepositoryPanelPreferences(normalizedRepositoryPanelPreferences);
  }, [normalizedRepositoryPanelPreferences, repositoryPanelPreferences.hidden, repositoryPanelPreferences.order]);

  useEffect(() => {
    if (!desiredVisibleRepositoryId) {
      return;
    }

    setRepositoryPanelPreferences((current) => {
      if (!current.hidden.includes(desiredVisibleRepositoryId)) {
        return current;
      }

      return {
        ...current,
        hidden: current.hidden.filter((id) => id !== desiredVisibleRepositoryId),
      };
    });
  }, [desiredVisibleRepositoryId]);

  useEffect(() => {
    const nextSelection = resolveVisibleRepositorySelection({
      allRepositories: orderedRepositories,
      visibleRepositories,
      selectedRepositoryId: repos.selectedRepositoryId,
      selectedWorktreeId: repos.selectedWorktreeId,
      desiredRepositoryId: search.repoId,
      desiredWorktreeId: search.worktreeId,
    });

    if (!nextSelection) {
      return;
    }

    if (
      nextSelection.repositoryId === repos.selectedRepositoryId
      && nextSelection.worktreeId === repos.selectedWorktreeId
    ) {
      return;
    }

    repos.setSelectedRepositoryId(nextSelection.repositoryId);
    repos.setSelectedWorktreeId(nextSelection.worktreeId);
  }, [
    repos.selectedRepositoryId,
    repos.selectedWorktreeId,
    repos.setSelectedRepositoryId,
    repos.setSelectedWorktreeId,
    search.repoId,
      search.worktreeId,
      visibleRepositories,
  ]);

  const handleToggleRepositoryExpand = useCallback((repositoryId: string, nextExpanded: boolean) => {
    setExpandedByRepo((current) => ({
      ...current,
      [repositoryId]: nextExpanded,
    }));
  }, []);

  const handleSetRepositoryVisibility = useCallback((repositoryId: string, visible: boolean) => {
    setRepositoryPanelPreferences((current) => {
      const nextHidden = visible
        ? current.hidden.filter((id) => id !== repositoryId)
        : current.hidden.includes(repositoryId)
          ? current.hidden
          : [...current.hidden, repositoryId];

      if (sameIds(nextHidden, current.hidden)) {
        return current;
      }

      return {
        ...current,
        hidden: nextHidden,
      };
    });
  }, []);

  const handleShowAllRepositories = useCallback(() => {
    setRepositoryPanelPreferences((current) => {
      if (current.hidden.length === 0) {
        return current;
      }

      return {
        ...current,
        hidden: [],
      };
    });
  }, []);

  const handleReorderRepositories = useCallback((draggedRepositoryId: string, targetRepositoryId: string, position: RepositoryPanelDropPosition) => {
    setRepositoryPanelPreferences((current) => {
      const normalized = normalizeRepositoryPanelPreferences(repos.repositories, current);
      const nextOrder = reorderRepositoryIds(normalized.order, draggedRepositoryId, targetRepositoryId, position);
      if (sameIds(nextOrder, normalized.order)) {
        return normalized === current ? current : normalized;
      }

      return {
        ...normalized,
        order: nextOrder,
      };
    });
  }, [repos.repositories]);

  const selectedIsRootWorkspace = !!(
    repos.selectedRepository &&
    repos.selectedWorktree &&
    isRootWorktree(repos.selectedWorktree, repos.selectedRepository)
  );
  const selectedTargetBranch = repos.selectedWorktree
    ? (selectedIsRootWorkspace
      ? repos.selectedRepository?.defaultBranch ?? null
      : repos.selectedWorktree.baseBranch)
    : null;

  const activeView = search.view ?? "chat";
  const rightPanelId = search.panel ?? null;
  const activeFilePath = activeView === "file" ? search.file ?? null : null;
  const activeFileLine = activeView === "file" ? search.fileLine ?? null : null;
  const activeFileColumn = activeView === "file" ? search.fileColumn ?? null : null;
  const selectedDiffFilePath = search.file ?? null;
  const reviewTabOpen = activeView === "review";
  const showWorkspaceHeader = activeView !== "automations";
  const [terminalTabsByWorktreeId, setTerminalTabsByWorktreeId] = useState<Record<string, WorkspaceTerminalTabsState>>({});
  const [terminalUiPersistenceRuntimePid, setTerminalUiPersistenceRuntimePid] = useState<number | null>(null);
  const selectedTerminalTabsState = getTerminalTabsState(terminalTabsByWorktreeId, repos.selectedWorktreeId);
  const activeTerminalTab = selectedTerminalTabsState.tabs.find((tab) => tab.id === selectedTerminalTabsState.activeTabId) ?? null;
  const terminalViewActive = activeView === "chat" && selectedTerminalTabsState.visible && activeTerminalTab !== null;
  const sessionShortcutHistoryRef = useRef<SessionShortcutTarget[]>([]);
  const sessionCtrlTabCycleRef = useRef<{
    baseHistory: SessionShortcutTarget[];
    index: number;
  } | null>(null);
  const openInAppShortcutBusyRef = useRef(false);
  const workspaceNavigation = useWorkspaceNavigationHistory({ search, updateSearch });
  const queryClient = useQueryClient();
  const startupBootstrapSelectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!desktopApp || !(restoredRepoId || restoredWorktreeId || restoredThreadId)) {
      return;
    }

    const selectionKey = `${restoredRepoId ?? ""}:${restoredWorktreeId ?? ""}:${restoredThreadId ?? ""}`;
    if (startupBootstrapSelectionKeyRef.current === selectionKey) {
      return;
    }
    startupBootstrapSelectionKeyRef.current = selectionKey;

    void startWorkspaceStartupBootstrap(queryClient, {
      selection: {
        repositoryId: restoredRepoId,
        worktreeId: restoredWorktreeId,
        threadId: restoredThreadId,
      },
    }).catch(() => {});
  }, [desktopApp, queryClient, restoredRepoId, restoredThreadId, restoredWorktreeId]);

  const installedAppsQuery = useInstalledApps({
    enabled: enableNonCriticalWorkspaceData,
  });

  const enableSidebarWorktreeStatuses = desktopApp || enableNonCriticalWorkspaceData;
  const backgroundStatusRepositories = enableSidebarWorktreeStatuses
    ? visibleRepositories
    : [];
  const backgroundStatusWorktreeIds = useMemo(
    () => buildRepositoryWorktreeIndex(backgroundStatusRepositories).activeWorktreeIds,
    [backgroundStatusRepositories],
  );
  const backgroundStatusThreadSnapshot = useThreadsByWorktreeIds(backgroundStatusWorktreeIds, {
    enabled: enableSidebarWorktreeStatuses,
  });
  const activeBackgroundThreadIds = useMemo(() => {
    return new Set(
      Object.values(backgroundStatusThreadSnapshot.threadsByWorktreeId)
        .flatMap((threads) => threads)
        .filter((thread) => thread.active)
        .map((thread) => thread.id),
    );
  }, [backgroundStatusThreadSnapshot]);
  const activeBackgroundThreadIdsByWorktreeId = useMemo(() => {
    return Object.fromEntries(
      Object.entries(backgroundStatusThreadSnapshot.threadsByWorktreeId).map(([worktreeId, threads]) => [
        worktreeId,
        new Set(threads.filter((thread) => thread.active).map((thread) => thread.id)),
      ]),
    );
  }, [backgroundStatusThreadSnapshot]);
  const selectedWorktreeStatus = repos.selectedWorktree?.status ?? null;
  const selectedWorktreeOperational = selectedWorktreeStatus != null && isOperationalWorktreeStatus(selectedWorktreeStatus);
  const selectedWorktreePending = selectedWorktreeStatus != null && isPendingWorktreeStatus(selectedWorktreeStatus);
  const selectedWorktreeLandingHold = !!(
    repos.selectedWorktreeId
    && workspaceLandingHoldByWorktreeId[repos.selectedWorktreeId]
  );
  const allowUnselectedWorkspaceChat = selectedWorktreeLandingHold;
  const nonCriticalWorktreeId = enableNonCriticalWorkspaceData && selectedWorktreeOperational ? repos.selectedWorktreeId : null;
  const prioritizeGitPanelData = rightPanelId === "git" || reviewTabOpen;
  const gitChanges = useGitChanges(
    repos.selectedWorktreeId,
    (enableNonCriticalWorkspaceData || prioritizeGitPanelData) && !!repos.selectedWorktreeId && selectedWorktreeOperational,
  );
  const selectedWorktreeUnavailable = selectedWorktreeOperational
    && isUnavailableWorktreeErrorMessage(gitChanges.error);
  const repositoryLiveDataEnabled = (enableNonCriticalWorkspaceData || prioritizeGitPanelData)
    && !selectedWorktreeUnavailable;
  const nonCriticalRepositoryId = enableNonCriticalWorkspaceData && !selectedWorktreeUnavailable
    ? repos.selectedRepositoryId
    : null;
  const targetBranchRepositoryId = selectedWorktreeOperational && !selectedWorktreeUnavailable
    ? repos.selectedRepositoryId
    : null;
  const repositoryReviews = useRepositoryReviews(
    repositoryLiveDataEnabled
      ? repos.selectedRepositoryId
      : null,
    {
      enabled: repositoryLiveDataEnabled,
    },
  );

  const runtimeInfo = useRuntimeInfo();
  const runtimePid = runtimeInfo.data?.pid ?? null;
  const selectedReviewBranch = resolveReviewBranch(gitChanges.branch, repos.selectedWorktree?.branch ?? null);
  const selectedReviewBaseBranch = resolveReviewBaseBranch(
    repos.selectedWorktree?.baseBranch ?? null,
    repos.selectedRepository?.defaultBranch ?? null,
  );
  const selectedWorktreeIsBaseBranch = isBaseBranchSelected(selectedReviewBranch, selectedReviewBaseBranch);
  const selectedReviewBranchKey = selectedReviewBranch ?? repos.selectedWorktree?.branch ?? null;
  const selectedLatestReviewRef = resolveSelectedLatestReviewRef({
    available: repositoryReviews.data?.available,
    branchKey: selectedReviewBranchKey,
    reviewsByBranch: repositoryReviews.data?.reviewsByBranch,
    worktreeSelected: repos.selectedWorktree != null,
    worktreeUnavailable: selectedWorktreeUnavailable,
  });
  const selectedReviewRef = selectedLatestReviewRef?.state === "open" ? selectedLatestReviewRef : null;
  const reviewKind: ReviewKind = repositoryReviews.data?.kind ?? "pr";
  const selectedOpenInAppTargetPath = selectedWorktreeOperational ? repos.selectedWorktree?.path ?? null : null;
  const selectedOpenInApp = selectedOpenInAppTargetPath
    ? resolvePreferredApp(installedAppsQuery.data ?? [], selectedOpenInAppTargetPath)
    : null;
  const displayGitBranch = gitChanges.branch || repos.selectedWorktree?.branch || "";
  const activeGitChangeEntry = activeFilePath
    ? gitChanges.entries.find((entry) => entry.path === activeFilePath) ?? null
    : null;
  const activeGitBaselineVersionKey = [
    gitChanges.branch,
    activeGitChangeEntry?.status ?? "clean",
    activeGitChangeEntry?.insertions ?? 0,
    activeGitChangeEntry?.deletions ?? 0,
  ].join(":");

  const chat = useChatSession(repos.selectedWorktreeId, setError, repos.updateWorktreeBranch, {
    desiredThreadId: desiredChatThreadId,
    desiredWorktreeId: desiredChatWorktreeId,
    repositoryId: repos.selectedRepositoryId,
    worktreeStatus: selectedWorktreeStatus,
    autoCreateInitialThread: false,
    allowUnselectedThread: allowUnselectedWorkspaceChat,
    timelineEnabled: !reviewTabOpen,
    onThreadChange: useCallback(
      (threadId: string | null) => {
        debugLog("workspace.selection.navigation", "chat.onThreadChange", {
          nextThreadId: threadId,
          routeRepoId: search.repoId ?? null,
          routeWorktreeId: search.worktreeId ?? null,
          routeThreadId: search.threadId ?? null,
          selectedRepositoryId: repos.selectedRepositoryId,
          selectedWorktreeId: repos.selectedWorktreeId,
          pendingRepoId: pendingWorktreeSearchSelectionRef.current?.repoId ?? null,
          pendingWorktreeId: pendingWorktreeSearchSelectionRef.current?.worktreeId ?? null,
          pendingThreadId: pendingWorktreeSearchSelectionRef.current?.threadId ?? null,
          startupSelectionFallbackActive,
        }, {
          threadId,
          worktreeId: repos.selectedWorktreeId,
          force: true,
        });
        if (startupSelectionFallbackActive) {
          setStartupSelectionFallbackActive(false);
        }
        updateSearch({ threadId: threadId ?? undefined });
      },
      [repos.selectedRepositoryId, repos.selectedWorktreeId, search.repoId, search.threadId, search.worktreeId, startupSelectionFallbackActive, updateSearch],
    ),
  });
  const selectionOscillationHistoryRef = useRef<Array<{
    atMs: number;
    scopeKey: string;
    repositoryId: string | null;
    worktreeId: string | null;
    threadId: string | null;
    routeRepoId: string | null;
    routeWorktreeId: string | null;
    routeThreadId: string | null;
    pendingRepoId: string | null;
    pendingWorktreeId: string | null;
    pendingThreadId: string | null;
  }>>([]);
  const selectionOscillationSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const pendingSelection = pendingWorktreeSearchSelectionRef.current;
    const atMs = typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
    const snapshot = {
      atMs: Math.round(atMs * 10) / 10,
      scopeKey: `${repos.selectedRepositoryId ?? "null"}:${repos.selectedWorktreeId ?? "null"}:${chat.selectedThreadId ?? "null"}`,
      repositoryId: repos.selectedRepositoryId,
      worktreeId: repos.selectedWorktreeId,
      threadId: chat.selectedThreadId,
      routeRepoId: search.repoId ?? null,
      routeWorktreeId: search.worktreeId ?? null,
      routeThreadId: search.threadId ?? null,
      pendingRepoId: pendingSelection?.repoId ?? null,
      pendingWorktreeId: pendingSelection?.worktreeId ?? null,
      pendingThreadId: pendingSelection?.threadId ?? null,
    };

    const history = selectionOscillationHistoryRef.current;
    if (history.at(-1)?.scopeKey === snapshot.scopeKey) {
      return;
    }

    history.push(snapshot);
    selectionOscillationHistoryRef.current = history
      .filter((entry) => snapshot.atMs - entry.atMs <= 3_000)
      .slice(-8);

    const recent = selectionOscillationHistoryRef.current;
    if (recent.length < 4) {
      return;
    }

    const lastFour = recent.slice(-4);
    const oscillating =
      lastFour[0]?.scopeKey === lastFour[2]?.scopeKey
      && lastFour[1]?.scopeKey === lastFour[3]?.scopeKey
      && lastFour[0]?.scopeKey !== lastFour[1]?.scopeKey;
    if (!oscillating) {
      return;
    }

    const signature = lastFour.map((entry) => entry.scopeKey).join("|");
    if (selectionOscillationSignatureRef.current === signature) {
      return;
    }
    selectionOscillationSignatureRef.current = signature;

    debugLog("workspace.selection.oscillation", "detected", {
      history: recent,
      selectedRepositoryName: repos.selectedRepository?.name ?? null,
      selectedWorktreeBranch: repos.selectedWorktree?.branch ?? null,
      selectedThreadTitle: chat.threads.find((thread) => thread.id === chat.selectedThreadId)?.title ?? null,
      messageListEmptyState: chat.messageListEmptyState,
      selectedThreadUiStatus: chat.selectedThreadUiStatus,
    }, {
      threadId: chat.selectedThreadId,
      worktreeId: repos.selectedWorktreeId,
      force: true,
    });
  }, [
    chat.messageListEmptyState,
    chat.selectedThreadId,
    chat.selectedThreadUiStatus,
    chat.threads,
    repos.selectedRepository?.name,
    repos.selectedRepositoryId,
    repos.selectedWorktree?.branch,
    repos.selectedWorktreeId,
    search.repoId,
    search.threadId,
    search.worktreeId,
  ]);

  const [loadAllModelCatalogs, setLoadAllModelCatalogs] = useState(false);
  const claudeModelCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData,
    loadAllAgentCatalogs: loadAllModelCatalogs,
    catalogAgent: "claude",
    composerAgent: chat.composerAgent,
  });
  const claudeModelsQuery = useClaudeModels({
    enabled: claudeModelCatalogEnabled,
  });
  const claudeModels = useMemo<ClaudeModelCatalogEntry[]>(
    () => [...(claudeModelsQuery.data?.models ?? [])],
    [claudeModelsQuery.data?.models],
  );
  const codexCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData,
    loadAllAgentCatalogs: loadAllModelCatalogs,
    catalogAgent: "codex",
    composerAgent: chat.composerAgent,
  });
  const cursorModelCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData,
    loadAllAgentCatalogs: loadAllModelCatalogs,
    catalogAgent: "cursor",
    composerAgent: chat.composerAgent,
  });
  const opencodeModelCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData,
    loadAllAgentCatalogs: loadAllModelCatalogs,
    catalogAgent: "opencode",
    composerAgent: chat.composerAgent,
  });
  const codexModelsQuery = useCodexModels({
    enabled: codexCatalogEnabled,
  });
  const codexModels = useMemo(
    () => [...(codexModelsQuery.data?.models ?? [])],
    [codexModelsQuery.data?.models],
  );
  const cursorModelsQuery = useCursorModels({
    enabled: cursorModelCatalogEnabled,
  });
  const cursorModels = useMemo(
    () => [...(cursorModelsQuery.data?.models ?? [])],
    [cursorModelsQuery.data?.models],
  );
  const opencodeModelsQuery = useOpencodeModels({
    enabled: opencodeModelCatalogEnabled,
  });
  const opencodeModels = useMemo(
    () => [...(opencodeModelsQuery.data?.models ?? [])],
    [opencodeModelsQuery.data?.models],
  );
  const modelCatalogReadyByAgent = useMemo(() => ({
    claude: claudeModelsQuery.data !== undefined || claudeModelsQuery.isError,
    codex: codexModelsQuery.data !== undefined || codexModelsQuery.isError,
    cursor: cursorModelsQuery.data !== undefined || cursorModelsQuery.isError,
    opencode: opencodeModelsQuery.data !== undefined || opencodeModelsQuery.isError,
  }), [
    claudeModelsQuery.data,
    claudeModelsQuery.isError,
    codexModelsQuery.data,
    codexModelsQuery.isError,
    cursorModelsQuery.data,
    cursorModelsQuery.isError,
    opencodeModelsQuery.data,
    opencodeModelsQuery.isError,
  ]);
  const allModelCatalogsReady = modelCatalogReadyByAgent.claude
    && modelCatalogReadyByAgent.codex
    && modelCatalogReadyByAgent.cursor
    && modelCatalogReadyByAgent.opencode;
  const requestAllModelCatalogs = useCallback(() => {
    setLoadAllModelCatalogs(true);
  }, []);
  const handleOpenAgentModelSelector = useCallback(() => {
    requestAllModelCatalogs();
  }, [requestAllModelCatalogs]);
  useEffect(() => {
    if (!shouldAutoLoadAllWorkspaceAgentCatalogs({
      enableNonCriticalWorkspaceData,
      loadAllAgentCatalogs: loadAllModelCatalogs,
    })) {
      return;
    }

    setLoadAllModelCatalogs(true);
  }, [enableNonCriticalWorkspaceData, loadAllModelCatalogs]);
  const slashCommandCatalogWorktreeId = enableNonCriticalWorkspaceData && selectedWorktreeOperational
    ? repos.selectedWorktreeId
    : null;
  const slashCommandCatalogsEnabled = slashCommandCatalogWorktreeId != null;
  const [loadAllSlashCommandCatalogs, setLoadAllSlashCommandCatalogs] = useState(false);
  const claudeSlashCommandCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData: slashCommandCatalogsEnabled,
    loadAllAgentCatalogs: loadAllSlashCommandCatalogs,
    catalogAgent: "claude",
    composerAgent: chat.composerAgent,
  });
  const codexSlashCommandCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData: slashCommandCatalogsEnabled,
    loadAllAgentCatalogs: loadAllSlashCommandCatalogs,
    catalogAgent: "codex",
    composerAgent: chat.composerAgent,
  });
  const cursorSlashCommandCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData: slashCommandCatalogsEnabled,
    loadAllAgentCatalogs: loadAllSlashCommandCatalogs,
    catalogAgent: "cursor",
    composerAgent: chat.composerAgent,
  });
  const opencodeSlashCommandCatalogEnabled = shouldLoadWorkspaceAgentCatalog({
    enableNonCriticalWorkspaceData: slashCommandCatalogsEnabled,
    loadAllAgentCatalogs: loadAllSlashCommandCatalogs,
    catalogAgent: "opencode",
    composerAgent: chat.composerAgent,
  });
  const claudeSlashCommandsQuery = useSlashCommandsQuery(slashCommandCatalogWorktreeId, "claude", {
    enabled: claudeSlashCommandCatalogEnabled,
  });
  const codexSlashCommandsQuery = useSlashCommandsQuery(slashCommandCatalogWorktreeId, "codex", {
    enabled: codexSlashCommandCatalogEnabled,
  });
  const cursorSlashCommandsQuery = useSlashCommandsQuery(slashCommandCatalogWorktreeId, "cursor", {
    enabled: cursorSlashCommandCatalogEnabled,
  });
  const opencodeSlashCommandsQuery = useSlashCommandsQuery(slashCommandCatalogWorktreeId, "opencode", {
    enabled: opencodeSlashCommandCatalogEnabled,
  });
  const composerSlashCommands = chat.composerAgent === "codex"
    ? (codexSlashCommandsQuery.data?.commands ?? [])
    : chat.composerAgent === "cursor"
      ? (cursorSlashCommandsQuery.data?.commands ?? [])
      : chat.composerAgent === "opencode"
        ? (opencodeSlashCommandsQuery.data?.commands ?? [])
        : (claudeSlashCommandsQuery.data?.commands ?? []);
  const composerSlashCommandsLoading = chat.composerAgent === "codex"
    ? codexSlashCommandsQuery.isLoading
    : chat.composerAgent === "cursor"
      ? cursorSlashCommandsQuery.isLoading
      : chat.composerAgent === "opencode"
        ? opencodeSlashCommandsQuery.isLoading
        : claudeSlashCommandsQuery.isLoading;
  useEffect(() => {
    if (!shouldAutoLoadAllWorkspaceAgentCatalogs({
      enableNonCriticalWorkspaceData: slashCommandCatalogsEnabled,
      loadAllAgentCatalogs: loadAllSlashCommandCatalogs,
    })) {
      return;
    }

    setLoadAllSlashCommandCatalogs(true);
  }, [loadAllSlashCommandCatalogs, slashCommandCatalogsEnabled]);
  pushStartupRenderProfileSection("chat-session");
  const selectedThreadIdCandidateForLiveStatus = chat.selectedThreadIdForData ?? chat.selectedThreadId;
  const selectedThreadIdForLiveStatus = isOptimisticThreadId(selectedThreadIdCandidateForLiveStatus)
    ? null
    : selectedThreadIdCandidateForLiveStatus;
  const selectedWorktreeStatusOverride = useMemo(() => {
    if (
      !repos.selectedWorktreeId
      || !selectedThreadIdForLiveStatus
      || chat.selectedThreadUiStatus === "idle"
    ) {
      return null;
    }

    return {
      kind: chat.selectedThreadUiStatus,
      threadId: selectedThreadIdForLiveStatus,
    } as const;
  }, [chat.selectedThreadUiStatus, repos.selectedWorktreeId, selectedThreadIdForLiveStatus]);
  const [worktreeStatusOverrides, setWorktreeStatusOverrides] = useState<Record<string, WorktreeStatusSummary>>({});
  const worktreeStatusOverridesRef = useRef(worktreeStatusOverrides);
  const applyWorktreeStatusOverrideUpdate = useCallback(
    (resolveNext: (current: Record<string, WorktreeStatusSummary>) => Record<string, WorktreeStatusSummary>) => {
      const current = worktreeStatusOverridesRef.current;
      const next = resolveNext(current);
      if (next === current) {
        return;
      }

      worktreeStatusOverridesRef.current = next;
      setWorktreeStatusOverrides(next);
    },
    [],
  );
  const overrideThreadIds = useMemo(
    () =>
      [...new Set(
        Object.values(worktreeStatusOverrides)
          .map((override) => override.threadId)
          .filter((threadId): threadId is string => (
            typeof threadId === "string"
            && threadId.length > 0
            && !isOptimisticThreadId(threadId)
          )),
      )].sort(),
    [worktreeStatusOverrides],
  );
  const overrideStatusSnapshotResults = useQueries({
    queries: overrideThreadIds.map((threadId) => ({
      queryKey: queryKeys.threads.statusSnapshot(threadId),
      queryFn: () => api.getThreadStatusSnapshot(threadId),
      enabled: enableSidebarWorktreeStatuses && threadId.length > 0,
      staleTime: 15_000,
    })),
  });
  const overrideStatusSnapshotsByThreadId = useMemo(() => {
    const entries = overrideThreadIds.map((threadId, index) => [
      threadId,
      overrideStatusSnapshotResults[index]?.data ?? null,
    ] as const);
    return Object.fromEntries(entries);
  }, [overrideStatusSnapshotResults, overrideThreadIds]);
  useEffect(() => {
    applyWorktreeStatusOverrideUpdate((current) => {
      return reconcileWorktreeStatusOverrides({
        current,
        selectedWorktreeId: repos.selectedWorktreeId,
        selectedWorktreeStatusOverride,
        activeThreadIdsByWorktreeId: activeBackgroundThreadIdsByWorktreeId,
      });
    });
  }, [activeBackgroundThreadIdsByWorktreeId, applyWorktreeStatusOverrideUpdate, repos.selectedWorktreeId, selectedWorktreeStatusOverride]);
  useEffect(() => {
    applyWorktreeStatusOverrideUpdate((current) => {
      return pruneSettledWorktreeStatusOverrides({
        current,
        selectedWorktreeId: repos.selectedWorktreeId,
        statusSnapshotsByThreadId: overrideStatusSnapshotsByThreadId,
        activeThreadIds: activeBackgroundThreadIds,
        selectedWorktreeStatusOverride,
      });
    });
  }, [
    activeBackgroundThreadIds,
    applyWorktreeStatusOverrideUpdate,
    overrideStatusSnapshotsByThreadId,
    repos.selectedWorktreeId,
    selectedWorktreeStatusOverride,
  ]);
  useEffect(() => {
    worktreeStatusOverridesRef.current = worktreeStatusOverrides;
  }, [worktreeStatusOverrides]);
  const previousLiveScopeSelectionRef = useRef<WorkspaceLiveScopeSelection | null>(null);
  const [liveScopeSwitch, setLiveScopeSwitch] = useState<WorkspaceLiveScopeSwitch | null>(null);

  useEffect(() => {
    const nextSelection: WorkspaceLiveScopeSelection = {
      repositoryId: repos.selectedRepositoryId,
      threadId: selectedThreadIdForLiveStatus,
      worktreeId: repos.selectedWorktreeId,
    };
    const previousSelection = previousLiveScopeSelectionRef.current;
    previousLiveScopeSelectionRef.current = nextSelection;

    if (!previousSelection) {
      return;
    }

    const nextTransition = createWorkspaceLiveScopeSwitch(previousSelection, nextSelection, Date.now());
    if (nextTransition) {
      setLiveScopeSwitch(nextTransition);
    }
  }, [repos.selectedRepositoryId, repos.selectedWorktreeId, selectedThreadIdForLiveStatus]);

  useEffect(() => {
    if (!shouldReleaseStartupSelectionFallback({
      loadingRepos: repos.loadingRepos,
      messageListEmptyState: chat.messageListEmptyState,
      runtimeState: startupState.runtimeState,
      selectedThreadId: chat.selectedThreadId,
      selectedWorktreeId: repos.selectedWorktreeId,
      selectionFallbackActive: startupSelectionFallbackActive,
    })) {
      return;
    }

    setStartupSelectionFallbackActive(false);
  }, [
    chat.messageListEmptyState,
    chat.selectedThreadId,
    repos.loadingRepos,
    repos.selectedWorktreeId,
    startupSelectionFallbackActive,
    startupState.runtimeState,
  ]);

  useEffect(() => {
    if (!repos.selectedWorktreeId || chat.selectedThreadId == null || !selectedWorktreeLandingHold) {
      return;
    }

    setWorkspaceLandingHold(repos.selectedWorktreeId, false);
  }, [chat.selectedThreadId, repos.selectedWorktreeId, selectedWorktreeLandingHold, setWorkspaceLandingHold]);
  const startupBannerSnapshot = startupState.runtimeState === "ready" ? null : startupState.snapshot;
  const startupRepositoryName = repos.selectedRepository?.name
    ?? null;
  const startupWorktreeBranch = repos.selectedWorktree?.branch
    ?? null;
  const startupWorktreePath = repos.selectedWorktree?.path
    ?? null;
  const selectedThreadShell = chat.threads.find((thread) => thread.id === search.threadId)
    ?? chat.threads.find((thread) => thread.id === chat.selectedThreadId)
    ?? null;
  const startupShellFallback = resolveStartupShellFallbackState({
    snapshot: startupState.snapshot,
    desiredRepoId: restoredRepoId,
    desiredWorktreeId: restoredWorktreeId,
    desiredThreadId: restoredThreadId,
    liveRepoId: repos.selectedRepositoryId,
    liveRepoName: repos.selectedRepository?.name ?? null,
    liveWorktreeId: repos.selectedWorktreeId,
    liveWorktreeBranch: repos.selectedWorktree?.branch ?? null,
    liveWorktreePath: repos.selectedWorktree?.path ?? null,
    liveThreadId: selectedThreadShell?.id ?? chat.selectedThreadId ?? null,
    liveThreadTitle: selectedThreadShell?.title ?? null,
  });
  const startupSnapshot = startupShellFallback.snapshot;
  const startupRepoFallbackActive = startupShellFallback.repoFallbackActive;
  const startupWorktreeFallbackActive = startupShellFallback.worktreeFallbackActive;
  const startupThreadFallbackActive = startupShellFallback.threadFallbackActive;
  const resolvedStartupRepositoryName = startupRepositoryName
    ?? (startupRepoFallbackActive ? startupSnapshot?.repoName ?? null : null);
  const resolvedStartupWorktreeBranch = startupWorktreeBranch
    ?? (startupWorktreeFallbackActive ? startupSnapshot?.worktreeBranch ?? null : null);
  const resolvedStartupWorktreePath = startupWorktreePath
    ?? (startupWorktreeFallbackActive ? startupSnapshot?.worktreePath ?? null : null);
  const startupThreadTitle = selectedThreadShell?.title
    ?? (startupThreadFallbackActive ? startupSnapshot?.threadTitle ?? null : null);
  const selectedThreadTitle = startupThreadTitle ?? "Chat";
  const preserveStartupThreadFallback = shouldPreserveStartupThreadFallback({
    threadFallbackActive: startupThreadFallbackActive,
    loadingRepos: repos.loadingRepos,
    messageListEmptyState: chat.messageListEmptyState,
    runtimeState: startupState.runtimeState,
  });
  const unavailableWorktreeRecoveryKeyRef = useRef<string | null>(null);
  const startupMetricRepositoryId = repos.selectedRepositoryId ?? restoredRepoId ?? null;
  const startupMetricWorktreeId = repos.selectedWorktreeId ?? restoredWorktreeId ?? null;
  const startupMetricThreadId = chat.selectedThreadId ?? restoredThreadId ?? null;
  const startupWorkspaceShellReady = hasStartupWorkspaceShellReadyState({
    repositoryId: startupMetricRepositoryId,
    repositoryName: resolvedStartupRepositoryName,
    worktreeId: startupMetricWorktreeId,
    worktreeBranch: resolvedStartupWorktreeBranch,
    worktreePath: resolvedStartupWorktreePath,
  });
  const startupNonCriticalDataReady = hasStartupNonCriticalDataReadyState({
    workspaceShellReady: startupWorkspaceShellReady,
    startupThreadId: startupMetricThreadId,
    messageListEmptyState: chat.messageListEmptyState,
    repositoriesLoading: repos.loadingRepos,
    selectedRepositoryId: repos.selectedRepositoryId,
    selectedWorktreeId: repos.selectedWorktreeId,
    selectedThreadId: chat.selectedThreadId,
  });
  const lastLoggedTabShellStateRef = useRef<string | null>(null);

  useEffect(() => {
    if (enableNonCriticalWorkspaceData || !startupNonCriticalDataReady) {
      return;
    }

    return scheduleWindowIdleTask(() => {
      setEnableNonCriticalWorkspaceData(true);
    }, {
      timeout: 1_500,
      fallbackDelayMs: 200,
    });
  }, [enableNonCriticalWorkspaceData, startupNonCriticalDataReady]);

  useEffect(() => {
    measureStartupMetricSinceBoot("startup.shell_visible_ms", {
      source: "WorkspacePage",
      target: desktopApp ? "desktop" : "web",
      routeRepoId: search.repoId ?? null,
      routeWorktreeId: search.worktreeId ?? null,
      routeThreadId: search.threadId ?? null,
    });
    emitStartupSnapshotReadMetric({
      source: "WorkspacePage",
    });
    finalizeStartupBlankScreenMetric({
      source: "WorkspacePage",
      reason: "workspace-shell-visible",
    });
  }, []);

  useEffect(() => {
    if (!runtimeInfo.data) {
      return;
    }

    measureStartupMetricSinceBoot("startup.runtime_connected_ms", {
      source: "runtime-info-query",
      pid: runtimeInfo.data.pid,
    });
  }, [runtimeInfo.data]);

  useEffect(() => {
    if (!startupWorkspaceShellReady) {
      return;
    }

    measureStartupMetricSinceBoot("startup.selected_workspace_ready_ms", {
      source: "WorkspacePage",
      repositoryId: startupMetricRepositoryId,
      worktreeId: startupMetricWorktreeId,
      usedSnapshotFallback: startupRepoFallbackActive || startupWorktreeFallbackActive,
    });
  }, [
    resolvedStartupRepositoryName,
    resolvedStartupWorktreeBranch,
    resolvedStartupWorktreePath,
    startupMetricRepositoryId,
    startupMetricWorktreeId,
    startupRepoFallbackActive,
    startupWorkspaceShellReady,
    startupWorktreeFallbackActive,
  ]);

  useEffect(() => {
    if (!hasStartupThreadShellReadyState({
      threadId: startupMetricThreadId,
      threadTitle: startupThreadTitle,
    })) {
      return;
    }

    measureStartupMetricSinceBoot("startup.selected_thread_shell_ready_ms", {
      source: "WorkspacePage",
      threadId: startupMetricThreadId,
      worktreeId: startupMetricWorktreeId,
      title: selectedThreadTitle,
      uiStatus: chat.selectedThreadUiStatus,
      usedSnapshotFallback: startupThreadFallbackActive,
    });
  }, [
    chat.selectedThreadUiStatus,
    selectedThreadTitle,
    startupThreadTitle,
    startupMetricThreadId,
    startupMetricWorktreeId,
    startupThreadFallbackActive,
  ]);

  useEffect(() => {
    if (!chat.selectedThreadId) {
      return;
    }

    if (!chatMessageListChunkReady) {
      return;
    }

    if (
      chat.messageListEmptyState === "loading-thread"
      || chat.messageListEmptyState === "creating-thread"
      || chat.messageListEmptyState === "no-thread-selected"
    ) {
      return;
    }

    measureStartupMetricSinceBoot("startup.selected_thread_timeline_ready_ms", {
      source: "WorkspacePage",
      threadId: chat.selectedThreadId,
      worktreeId: repos.selectedWorktreeId,
      timelineItemsCount: chat.timelineItems.length,
      messageListEmptyState: chat.messageListEmptyState,
      uiStatus: chat.selectedThreadUiStatus,
    });
    finalizeStartupBootstrapPayloadMetric({
      source: "WorkspacePage",
      settledAt: "selected-thread-timeline-ready",
    });
  }, [
    chatMessageListChunkReady,
    chat.messageListEmptyState,
    chat.selectedThreadId,
    chat.selectedThreadUiStatus,
    chat.timelineItems.length,
    repos.selectedWorktreeId,
  ]);

  useEffect(() => {
    if (!selectedWorktreeUnavailable || repos.selectedWorktreeId == null) {
      unavailableWorktreeRecoveryKeyRef.current = null;
      return;
    }

    const recoveryKey = `${repos.selectedRepositoryId ?? "null"}:${repos.selectedWorktreeId}:${gitChanges.error ?? ""}`;
    if (unavailableWorktreeRecoveryKeyRef.current === recoveryKey) {
      return;
    }
    unavailableWorktreeRecoveryKeyRef.current = recoveryKey;

    const nextSelection = resolveUnavailableWorktreeSelection({
      visibleRepositories: orderedRepositories,
      selectedRepositoryId: repos.selectedRepositoryId,
      selectedWorktreeId: repos.selectedWorktreeId,
    });

    writeWorkspaceShellStateSnapshot(null);

    if (!nextSelection) {
      return;
    }

    setRepositoryPanelPreferences((current) => (
      current.hidden.length > 0
        ? {
          ...current,
          hidden: [],
        }
        : current
    ));
    repos.setSelectedRepositoryId(nextSelection.repositoryId);
    repos.setSelectedWorktreeId(nextSelection.worktreeId);
  }, [
    gitChanges.error,
    orderedRepositories,
    repos.selectedRepositoryId,
    repos.selectedWorktreeId,
    repos.setSelectedRepositoryId,
    repos.setSelectedWorktreeId,
    selectedWorktreeUnavailable,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const hasLiveShellData = !selectedWorktreeUnavailable && !!(
      repos.selectedRepositoryId
      || repos.selectedWorktreeId
      || (chat.selectedThreadId && selectedThreadShell)
    );

    if (!hasLiveShellData) {
      if (shouldClearPersistedStartupShell({
        criticalWorkspaceDataEnabled: enableCriticalWorkspaceData,
        hasLiveShellData,
        hasUnavailableSelectedWorktree: selectedWorktreeUnavailable,
        loadingRepos: repos.loadingRepos,
        repositoriesCount: repos.repositories.length,
        runtimeState: startupState.runtimeState,
      })) {
        writeWorkspaceShellStateSnapshot(null);
      }
      return;
    }

    const preserveStartupRepositoryListFallback = startupSelectionFallbackActive
      || startupState.runtimeState !== "ready"
      || repos.loadingRepos;
    const nextSnapshot = buildStartupShellSnapshot({
      ...mergeStartupShellSnapshotInputFromFallback({
      liveInput: {
        repoId: repos.selectedRepositoryId,
        repoName: repos.selectedRepository?.name ?? null,
        worktreeId: repos.selectedWorktreeId,
        worktreeBranch: repos.selectedWorktree?.branch ?? null,
        worktreePath: repos.selectedWorktree?.path ?? null,
        worktreeStatus: repos.selectedWorktree?.status ?? null,
        threadId: chat.selectedThreadId,
        threadTitle: selectedThreadShell?.title ?? null,
        threadStatus: chat.selectedThreadId != null ? chat.selectedThreadUiStatus : null,
      },
      fallbackSnapshot: startupSnapshot,
      preserveRepoFallback: startupRepoFallbackActive,
      preserveWorktreeFallback: startupWorktreeFallbackActive,
      preserveThreadFallback: preserveStartupThreadFallback,
      }),
      repositories: preserveStartupRepositoryListFallback
        ? startupSnapshot?.repositories ?? startupRepositorySnapshots
        : startupRepositorySnapshots,
      hiddenRepositoryIds: preserveStartupRepositoryListFallback
        ? startupSnapshot?.hiddenRepositoryIds ?? hiddenRepositoryIds
        : hiddenRepositoryIds,
      expandedRepositoryIds: preserveStartupRepositoryListFallback
        ? startupSnapshot?.expandedRepositoryIds ?? snapshotExpandedRepositoryIds
        : snapshotExpandedRepositoryIds,
    });

    writeWorkspaceShellStateSnapshot(nextSnapshot);
  }, [
    chat.selectedThreadId,
    chat.selectedThreadUiStatus,
    chat.messageListEmptyState,
    enableCriticalWorkspaceData,
    preserveStartupThreadFallback,
    repos.loadingRepos,
    repos.repositories.length,
    repos.selectedRepository?.name,
    repos.selectedRepositoryId,
    repos.selectedWorktree?.branch,
    repos.selectedWorktree?.path,
    repos.selectedWorktree?.status,
    repos.selectedWorktreeId,
    selectedThreadShell,
    selectedWorktreeUnavailable,
    startupRepoFallbackActive,
    startupRepositorySnapshots,
    startupSnapshot,
    startupState.runtimeState,
    startupThreadFallbackActive,
    startupSelectionFallbackActive,
    startupWorktreeFallbackActive,
    hiddenRepositoryIds,
    snapshotExpandedRepositoryIds,
  ]);

  useEffect(() => {
    if (chat.selectedThreadId != null || chat.messageListEmptyState !== "no-thread-selected" || !repos.selectedWorktreeId) {
      return;
    }

    finalizeStartupBootstrapPayloadMetric({
      source: "WorkspacePage",
      settledAt: "workspace-ready-without-thread",
      worktreeId: repos.selectedWorktreeId,
    });
  }, [
    chat.messageListEmptyState,
    chat.selectedThreadId,
    repos.selectedWorktreeId,
  ]);

  const prMrThread = chat.threads.find((thread) => thread.kind === "review") ?? null;
  const prMrThreadIsActiveOrPending = !!prMrThread && (
    prMrThread.active
    || prMrThread.id === chat.waitingAssistant?.threadId
    || (chat.sendingMessage && prMrThread.id === chat.selectedThreadId)
  );
  const runtimeLabel = formatRuntimeLabel(runtimeInfo.data);
  const runtimeTitle = formatRuntimeTitle(runtimeInfo.data);

  useEffect(() => {
    if (typeof window === "undefined" || runtimePid == null || terminalUiPersistenceRuntimePid === runtimePid) {
      return;
    }

    let cancelled = false;
    const runtimeChanged = terminalUiPersistenceRuntimePid != null && terminalUiPersistenceRuntimePid !== runtimePid;
    const markReady = () => {
      if (!cancelled) {
        setTerminalUiPersistenceRuntimePid(runtimePid);
      }
    };
    const resetTerminalUiState = () => {
      startTransition(() => {
        setBottomPanelStateByWorktreeId({});
        setTerminalTabsByWorktreeId({});
      });
    };
    const persistedState = readPersistedWorkspaceTerminalUiState(window.sessionStorage);

    if (!persistedState || persistedState.runtimePid !== runtimePid) {
      if (runtimeChanged) {
        resetTerminalUiState();
      }
      markReady();
      return () => {
        cancelled = true;
      };
    }

    void api.listTerminalSessions()
      .then((terminalSessions) => {
        if (cancelled) {
          return;
        }

        const restoredState = restoreWorkspaceTerminalUiState({
          persistedState,
          runtimePid,
          terminalSessions,
        });

        startTransition(() => {
          setBottomPanelStateByWorktreeId(restoredState?.bottomPanelStateByWorktreeId ?? {});
          setTerminalTabsByWorktreeId(restoredState?.terminalTabsByWorktreeId ?? {});
        });
        markReady();
      })
      .catch(() => {
        if (runtimeChanged) {
          resetTerminalUiState();
        }
        markReady();
      });

    return () => {
      cancelled = true;
    };
  }, [runtimePid, terminalUiPersistenceRuntimePid]);

  useEffect(() => {
    if (typeof window === "undefined" || runtimePid == null || terminalUiPersistenceRuntimePid !== runtimePid) {
      return;
    }

    try {
      writePersistedWorkspaceTerminalUiState(window.sessionStorage, {
        runtimePid,
        bottomPanelStateByWorktreeId,
        terminalTabsByWorktreeId,
      });
    } catch {
      // Ignore sessionStorage write failures and keep the live UI responsive.
    }
  }, [
    bottomPanelStateByWorktreeId,
    runtimePid,
    terminalTabsByWorktreeId,
    terminalUiPersistenceRuntimePid,
  ]);

  const isThreadHistoryLocallyComplete = chat.isThreadHistoryLocallyComplete;
  const prefetchDisplayThreadSnapshot = useCallback((threadId: string) => {
    if (isOptimisticThreadId(threadId) || isThreadHistoryLocallyComplete(threadId)) {
      return Promise.resolve();
    }

    return queryClient.prefetchQuery({
      queryKey: queryKeys.threads.timelineSnapshot(threadId),
      queryFn: () => api.getTimelineSnapshot(threadId),
      staleTime: THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS,
    });
  }, [isThreadHistoryLocallyComplete, queryClient]);
  const prefetchWorktreeNavigationTarget = useCallback(async (worktreeId: string, preferredThreadId?: string | null) => {
    const inFlight = navigationPrefetchRef.current.get(worktreeId);
    if (inFlight) {
      return inFlight;
    }

    const prefetchTask = (async () => {
      const rememberedThreadId = preferredThreadId ?? null;
      const cachedThreads = (getThreadsCollection(queryClient, worktreeId).toArray as ChatThread[])
        .map((thread) => ({ ...thread }));
      const cachedThreadId = resolvePreferredThreadIdFromThreads(cachedThreads, rememberedThreadId);

      const pendingTasks: Promise<unknown>[] = [
        refetchGitStatusCollection(queryClient, worktreeId),
      ];

      if (cachedThreadId) {
        pendingTasks.push(prefetchDisplayThreadSnapshot(cachedThreadId));
      }

      const refreshedThreadsTask = api.listThreads(worktreeId)
        .then((threads) => {
          replaceThreadsCollection(queryClient, worktreeId, threads);
          return threads;
        })
        .catch(() => cachedThreads);

      pendingTasks.push(refreshedThreadsTask);

      const settledResults = await Promise.allSettled(pendingTasks);
      const refreshedThreadsResult = settledResults[settledResults.length - 1];
      const refreshedThreads = refreshedThreadsResult?.status === "fulfilled"
        ? refreshedThreadsResult.value as ChatThread[]
        : cachedThreads;

      const nextThreadId = resolvePreferredThreadIdFromThreads(refreshedThreads, rememberedThreadId);

      if (!nextThreadId || nextThreadId === cachedThreadId) {
        return;
      }

      await prefetchDisplayThreadSnapshot(nextThreadId);
    })().finally(() => {
      navigationPrefetchRef.current.delete(worktreeId);
    });

    navigationPrefetchRef.current.set(worktreeId, prefetchTask);
    return prefetchTask;
  }, [prefetchDisplayThreadSnapshot, queryClient]);
  const repositoryBranches = useRepositoryBranches(targetBranchRepositoryId, {
    enabled: !!targetBranchRepositoryId,
  });

  useEffect(() => {
    if (!liveScopeSwitch) {
      return;
    }

    const keepSwitching = shouldKeepWorkspaceLiveScopeSwitch({
      transition: liveScopeSwitch,
      nowMs: Date.now(),
      hasChatThreadSelection: selectedThreadIdForLiveStatus != null,
      hasRepositorySelection: nonCriticalRepositoryId != null,
      hasWorktreeSelection: nonCriticalWorktreeId != null,
      chatThreadState: chat.selectedThreadConnectionState,
      gitStatusState: gitChanges.connectionState,
      repositoryBranchesState: repositoryBranches.connectionState,
      repositoryReviewsState: repositoryReviews.connectionState,
    });

    if (!keepSwitching) {
      setLiveScopeSwitch((current) => current === liveScopeSwitch ? null : current);
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const remainingMs = Math.max(
      0,
      WORKSPACE_LIVE_SCOPE_SWITCH_MAX_MS - (Date.now() - liveScopeSwitch.startedAtMs),
    );
    const timeoutId = window.setTimeout(() => {
      setLiveScopeSwitch((current) => current === liveScopeSwitch ? null : current);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    chat.selectedThreadConnectionState,
    gitChanges.connectionState,
    liveScopeSwitch,
    nonCriticalRepositoryId,
    nonCriticalWorktreeId,
    repositoryBranches.connectionState,
    repositoryReviews.connectionState,
    selectedThreadIdForLiveStatus,
  ]);

  const chatDisplayStateOverride = liveScopeSwitch && (liveScopeSwitch.threadChanged || liveScopeSwitch.worktreeChanged)
    ? "switching"
    : null;
  const gitStatusDisplayStateOverride = liveScopeSwitch?.worktreeChanged
    ? "switching"
    : null;
  const repositoryLiveDisplayStateOverride = liveScopeSwitch?.repositoryChanged
    ? "switching"
    : null;
  const liveStatusItems = useMemo<WorkspaceLiveStatusItem[]>(() => [
    {
      domain: "chat_thread",
      connectionState: chat.selectedThreadConnectionState,
      displayStateOverride: chatDisplayStateOverride,
      errorMessage: chat.selectedThreadConnectionErrorMessage,
    },
    {
      domain: "git_status",
      connectionState: nonCriticalWorktreeId ? gitChanges.connectionState : null,
      displayStateOverride: nonCriticalWorktreeId ? gitStatusDisplayStateOverride : null,
      errorMessage: nonCriticalWorktreeId ? gitChanges.error : null,
    },
    {
      domain: "repository_reviews",
      connectionState: nonCriticalRepositoryId ? repositoryReviews.connectionState : null,
      displayStateOverride: nonCriticalRepositoryId ? repositoryLiveDisplayStateOverride : null,
      errorMessage: nonCriticalRepositoryId
        ? (repositoryReviews.error instanceof Error ? repositoryReviews.error.message : null)
        : null,
    },
    {
      domain: "repository_branches",
      connectionState: nonCriticalRepositoryId ? repositoryBranches.connectionState : null,
      displayStateOverride: nonCriticalRepositoryId ? repositoryLiveDisplayStateOverride : null,
      errorMessage: nonCriticalRepositoryId
        ? (repositoryBranches.error instanceof Error ? repositoryBranches.error.message : null)
        : null,
    },
  ], [
    chat.selectedThreadConnectionErrorMessage,
    chat.selectedThreadConnectionState,
    chatDisplayStateOverride,
    gitChanges.connectionState,
    gitChanges.error,
    gitStatusDisplayStateOverride,
    nonCriticalRepositoryId,
    nonCriticalWorktreeId,
    repositoryBranches.connectionState,
    repositoryBranches.error,
    repositoryLiveDisplayStateOverride,
    repositoryReviews.connectionState,
    repositoryReviews.error,
  ]);
  const liveError = useMemo(
    () => resolveWorkspaceLiveErrorSummary(liveStatusItems),
    [liveStatusItems],
  );
  const lastLiveBadgeDebugRef = useRef<string | null>(null);
  const [dismissedLiveErrorSignature, setDismissedLiveErrorSignature] = useState<string | null>(null);

  useEffect(() => {
    if (!liveError) {
      setDismissedLiveErrorSignature(null);
      return;
    }

    setDismissedLiveErrorSignature((current) => (
      current != null && current !== liveError.signature ? null : current
    ));
  }, [liveError]);

  useEffect(() => {
    const payload = {
      repositoryId: repos.selectedRepositoryId,
      worktreeId: repos.selectedWorktreeId,
      threadId: selectedThreadIdForLiveStatus,
      liveScopeSwitch: liveScopeSwitch ? {
        repositoryChanged: liveScopeSwitch.repositoryChanged,
        worktreeChanged: liveScopeSwitch.worktreeChanged,
        threadChanged: liveScopeSwitch.threadChanged,
      } : null,
      chatThread: {
        state: chat.selectedThreadConnectionState,
        override: chatDisplayStateOverride,
        error: chat.selectedThreadConnectionErrorMessage,
      },
      gitStatus: {
        state: gitChanges.connectionState,
        override: gitStatusDisplayStateOverride,
        error: toDebugErrorMessage(gitChanges.error),
      },
      repositoryReviews: {
        state: repositoryReviews.connectionState,
        override: repositoryLiveDisplayStateOverride,
        error: toDebugErrorMessage(repositoryReviews.error),
      },
      repositoryBranches: {
        state: repositoryBranches.connectionState,
        override: repositoryLiveDisplayStateOverride,
        error: toDebugErrorMessage(repositoryBranches.error),
      },
      liveError: liveError ? {
        title: liveError.title,
        description: liveError.description,
        signature: liveError.signature,
      } : null,
    };
    const serialized = JSON.stringify(payload);
    if (lastLiveBadgeDebugRef.current === serialized) {
      return;
    }
    lastLiveBadgeDebugRef.current = serialized;
    debugLog("workspace.live.badge", "state.changed", payload, {
      threadId: selectedThreadIdForLiveStatus,
      worktreeId: repos.selectedWorktreeId,
      force: true,
    });
  }, [
    chat.selectedThreadConnectionErrorMessage,
    chat.selectedThreadConnectionState,
    chatDisplayStateOverride,
    gitChanges.connectionState,
    gitChanges.error,
    gitStatusDisplayStateOverride,
    liveError,
    liveScopeSwitch,
    repositoryBranches.connectionState,
    repositoryBranches.error,
    repositoryLiveDisplayStateOverride,
    repositoryReviews.connectionState,
    repositoryReviews.error,
    repos.selectedRepositoryId,
    repos.selectedWorktreeId,
    selectedThreadIdForLiveStatus,
  ]);

  const gates = usePendingGates(chat.selectedThreadIdForData ?? chat.selectedThreadId, {
    onError: setError,
    startWaitingAssistant: chat.startWaitingAssistant,
    clearWaitingAssistantForThread: chat.clearWaitingAssistantForThread,
    authoritativeThreadStatus: chat.authoritativeThreadStatus,
    onPlanApproved: (result) => {
      if (result.executionKind === "handoff") {
        const handoffSearchPatch = buildPlanHandoffSearchPatch(result.executionThreadId);
        hideTerminalView(repos.selectedWorktreeId);
        setWorkspaceLandingHold(repos.selectedWorktreeId, false);
        chat.registerPendingHandoffThread({
          sourceThreadId: result.sourceThreadId,
          executionThreadId: result.executionThreadId,
          sourceThread: selectedThreadShell,
        });
        chat.setSelectedThreadId(result.executionThreadId, { preserveWhileMissing: true });
        chat.startWaitingAssistant(result.executionThreadId);
        updateSearch(handoffSearchPatch);
        debugLog("thread.plan.handoff", "navigated to handoff execution thread", {
          sourceThreadId: result.sourceThreadId,
          executionThreadId: result.executionThreadId,
          selectedWorktreeId: repos.selectedWorktreeId,
          activeView,
          activeFilePath,
          terminalViewActive,
          searchPatch: handoffSearchPatch,
        }, {
          threadId: result.executionThreadId,
          worktreeId: repos.selectedWorktreeId,
          force: true,
        });
      }
    },
  });
  pushStartupRenderProfileSection("pending-gates");
  const [activePermissionRequestId, setActivePermissionRequestId] = useState<string | null>(null);
  const [activeQuestionRequestId, setActiveQuestionRequestId] = useState<string | null>(null);

  const activePermissionIndex = useMemo(() => {
    if (gates.pendingPermissionRequests.length === 0) {
      return -1;
    }

    if (!activePermissionRequestId) {
      return 0;
    }

    return gates.pendingPermissionRequests.findIndex((request) => request.requestId === activePermissionRequestId);
  }, [activePermissionRequestId, gates.pendingPermissionRequests]);

  const activePermissionRequest = activePermissionIndex >= 0
    ? gates.pendingPermissionRequests[activePermissionIndex] ?? null
    : null;
  const hasMultiplePendingPermissions = gates.pendingPermissionRequests.length > 1;
  const activeQuestionIndex = useMemo(() => {
    if (gates.pendingQuestionRequests.length === 0) {
      return -1;
    }

    if (!activeQuestionRequestId) {
      return 0;
    }

    return gates.pendingQuestionRequests.findIndex((request) => request.requestId === activeQuestionRequestId);
  }, [activeQuestionRequestId, gates.pendingQuestionRequests]);
  const activeQuestionRequest = activeQuestionIndex >= 0
    ? gates.pendingQuestionRequests[activeQuestionIndex] ?? null
    : null;
  const hasMultiplePendingQuestions = gates.pendingQuestionRequests.length > 1;
  const { showPermissionGate, showQuestionGate } = deriveVisibleUserGates({
    pendingPermissionRequestCount: gates.pendingPermissionRequests.length,
    pendingQuestionRequestCount: gates.pendingQuestionRequests.length,
  });
  const [mobilePanelOpen, setMobilePanelOpen] = useState<MobilePanelState>(null);
  const [mobileReposOrigin, setMobileReposOrigin] = useState<MobileReposOrigin | null>(null);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() => desktopApp || isDesktopViewportNow());
  const [mobileKeyboardOffset, setMobileKeyboardOffset] = useState(0);
  const [workspaceFileIndexRequests, setWorkspaceFileIndexRequests] = useState<Record<string, true>>({});
  const navigationPrefetchRef = useRef<Map<string, Promise<void>>>(new Map());
  const activeMobileSection: "chat" | "files" | "git" | "more" = mobilePanelOpen === "more" || mobilePanelOpen === "utilities" || mobilePanelOpen === "device"
    ? "more"
    : mobilePanelOpen === "files"
      ? "files"
    : mobilePanelOpen === "git"
      ? "git"
        : "chat";
  const mobileInlinePanel = mobilePanelOpen === "files"
    || mobilePanelOpen === "git"
    || mobilePanelOpen === "more"
    || mobilePanelOpen === "utilities"
    || mobilePanelOpen === "device";
  const mobileUtilitiesFullscreen = mobilePanelOpen === "utilities";
  const mobileReposDrawerOpen = mobilePanelOpen === "repos";
  const desktopLayout = desktopApp || isDesktopViewport;
  const mobileReposOverlayOpen = !desktopApp && mobileReposDrawerOpen;
  const workspaceHeaderSelectedTabLabel = terminalViewActive
    ? activeTerminalTab?.title ?? "Terminal"
    : activeView === "file"
      ? labelFromPath(activeFilePath) || "File"
      : activeView === "review"
        ? "Review Changes"
        : selectedThreadTitle;
  const mobileTitle = mobilePanelOpen === "files"
    ? "Files"
    : mobilePanelOpen === "git"
      ? "Git"
      : mobilePanelOpen === "more"
        ? "More"
        : mobilePanelOpen === "utilities"
          ? "Utilities"
          : mobilePanelOpen === "device"
            ? "Devices"
            : terminalViewActive
              ? activeTerminalTab?.title ?? "Terminal"
            : activeView === "file"
              ? labelFromPath(activeFilePath)
            : activeView === "review"
              ? "Review Changes"
            : activeView === "automations"
              ? "Automations"
              : selectedThreadTitle;
  const mobileSubtitle = resolvedStartupRepositoryName
    ? `${resolvedStartupRepositoryName} · ${selectedIsRootWorkspace ? "Root Workspace" : resolvedStartupWorktreeBranch ?? "No worktree"}`
    : "No repository selected";

  const captureMobileReposOrigin = useCallback((): MobileReposOrigin => ({
    panel: mobilePanelOpen === "files" || mobilePanelOpen === "git" || mobilePanelOpen === "more" || mobilePanelOpen === "utilities" || mobilePanelOpen === "device"
      ? mobilePanelOpen
      : null,
    view: activeView === "file" || activeView === "review" || activeView === "automations" ? activeView : "chat",
  }), [activeView, mobilePanelOpen]);

  const handleOpenMobileRepositories = useCallback(() => {
    setMobileReposOrigin(captureMobileReposOrigin());
    setMobilePanelOpen("repos");
  }, [captureMobileReposOrigin]);

  const handleCloseMobileRepositories = useCallback(() => {
    setMobilePanelOpen(mobileReposOrigin?.panel ?? null);
    setMobileReposOrigin(null);
  }, [mobileReposOrigin]);
  const markWorkspaceFileIndexRequested = useCallback((worktreeId: string | null | undefined) => {
    if (!worktreeId) {
      return;
    }

    setWorkspaceFileIndexRequests((current) => (
      current[worktreeId] ? current : { ...current, [worktreeId]: true }
    ));
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [issueReportOpen, setIssueReportOpen] = useState(false);
  const [focusComposerSignal, setFocusComposerSignal] = useState(0);
  const [confirmCloseThreadId, setConfirmCloseThreadId] = useState<string | null>(null);
  const [confirmDeleteThreadId, setConfirmDeleteThreadId] = useState<string | null>(null);
  const openSettingsDialog = useCallback(() => {
    requestAllModelCatalogs();
    setSettingsOpen(true);
  }, [requestAllModelCatalogs]);

  useEffect(() => {
    if (enableCriticalWorkspaceData) {
      return;
    }

    if (shouldEagerlyEnableCriticalWorkspaceData({
      desktopApp,
      hasPersistedShellSnapshot: startupState.snapshot != null,
    })) {
      setEnableCriticalWorkspaceData(true);
      return;
    }

    return scheduleWindowIdleTask(() => {
      setEnableCriticalWorkspaceData(true);
    }, {
      timeout: 500,
      fallbackDelayMs: 1,
    });
  }, [desktopApp, enableCriticalWorkspaceData, startupState.snapshot]);

  useEffect(() => {
    if (desktopApp) {
      setIsDesktopViewport(true);
      return;
    }

    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const updateViewportMatch = () => {
      setIsDesktopViewport(mediaQuery.matches);
    };

    updateViewportMatch();
    mediaQuery.addEventListener("change", updateViewportMatch);
    return () => {
      mediaQuery.removeEventListener("change", updateViewportMatch);
    };
  }, [desktopApp]);

  useEffect(() => {
    if (!desktopApp || mobilePanelOpen === null) {
      return;
    }

    setMobilePanelOpen(null);
    setMobileReposOrigin(null);
  }, [desktopApp, mobilePanelOpen]);

  const workspaceFileIndexRequested = !!(
    repos.selectedWorktreeId
    && workspaceFileIndexRequests[repos.selectedWorktreeId]
  );
  const workspaceFileIndexEnabled = enableNonCriticalWorkspaceData
    && nonCriticalWorktreeId != null
    && (
      activeView === "file"
      || mobilePanelOpen === "files"
      || workspaceFileIndexRequested
    );
  const fileIndex = useFileIndex(workspaceFileIndexEnabled ? nonCriticalWorktreeId : null);
  const selectedChatThread = chat.selectedThreadId
    ? chat.threads.find((thread) => thread.id === chat.selectedThreadId) ?? null
    : null;

  useEffect(() => {
    if (!enableNonCriticalWorkspaceData || !repos.selectedWorktreeId || !chat.selectedThreadId) {
      return;
    }

    const siblingThreads = chat.threads.filter((thread) => (
      thread.worktreeId === repos.selectedWorktreeId && thread.id !== chat.selectedThreadId
    ));
    const threadsToPrefetch = siblingThreads.slice(-2);

    for (const thread of threadsToPrefetch) {
      void prefetchDisplayThreadSnapshot(thread.id);
    }
  }, [chat.selectedThreadId, chat.threads, enableNonCriticalWorkspaceData, prefetchDisplayThreadSnapshot, repos.selectedWorktreeId]);

  useEffect(() => {
    if (activeView === "file" || activeView === "review") {
      workspacePanelsPreloadedRef.current = true;
      return;
    }

    if (!shouldScheduleWorkspacePanelPreload({
      activeView,
      alreadyPreloaded: workspacePanelsPreloadedRef.current,
      enableNonCriticalWorkspaceData,
      hasSelectedWorktree: !!repos.selectedWorktreeId,
    })) {
      return;
    }

    return scheduleWindowIdleTask(() => {
      workspacePanelsPreloadedRef.current = true;
      void preloadCodeEditorPanel();
      void preloadDiffReviewPanel();
    }, {
      timeout: 2500,
      fallbackDelayMs: 2500,
    });
  }, [activeView, enableNonCriticalWorkspaceData, repos.selectedWorktreeId]);

  const {
    activeEditorFileState,
    activeEditorGitBaselineState,
    activeFileExternal,
    activeFileDirty,
    canDiscardDirtyWorktreeFiles,
    canSaveActiveFile,
    closeQuickFilePicker,
    confirmSwitchAwayFromActiveFile,
    filteredQuickFileItems,
    handleCloseFileTab: handleCloseFileTabInternal,
    handleEditorDraftChange,
    handlePinFileTab,
    handleQuickFileQueryChange,
    handleQuickFileSelect,
    handleQuickFileSelectedIndexChange,
    handleRetryActiveFileLoad,
    handleSaveActiveFile,
    handleSelectFileTab,
    openQuickFilePicker,
    openReadFile,
    quickFileInputRef,
    quickFilePicker,
    recentFilePaths,
    workspaceFileTabs,
  } = useWorkspaceFileEditor({
    activeFilePath,
    activeGitBaselineVersionKey,
    activeView,
    fileEntries: fileIndex.entries,
    onError: setError,
    onOpenQuickFilePicker: () => {
      markWorkspaceFileIndexRequested(repos.selectedWorktreeId);
      setMobilePanelOpen(null);
    },
    resolveSaveAutomationTargetSessionId,
    saveAutomation: repos.selectedRepository?.saveAutomation ?? null,
    selectedThreadId: chat.selectedThreadId,
    selectedWorktreeId: repos.selectedWorktreeId,
    selectedWorktreePath: repos.selectedWorktree?.path ?? null,
    updateSearch,
  });
  useEffect(() => {
    const threadIds = chat.threads.map((thread) => thread.id);
    const fileTabPaths = workspaceFileTabs.map((tab) => tab.path);
    const terminalTabIds = selectedTerminalTabsState.tabs.map((tab) => tab.id);
    const selectedThreadMissingFromCollection = !!chat.selectedThreadId && !threadIds.includes(chat.selectedThreadId);
    const routeThreadMissingFromCollection = !!search.threadId && !threadIds.includes(search.threadId);
    const tabShellState = {
      activeView,
      routeRepoId: search.repoId ?? null,
      routeWorktreeId: search.worktreeId ?? null,
      routeThreadId: search.threadId ?? null,
      selectedRepositoryId: repos.selectedRepositoryId,
      selectedWorktreeId: repos.selectedWorktreeId,
      selectedThreadId: chat.selectedThreadId,
      selectedThreadShellId: selectedThreadShell?.id ?? null,
      threadIds,
      fileTabPaths,
      terminalTabIds,
      activeFilePath,
      activeTerminalTabId: activeTerminalTab?.id ?? null,
      terminalViewActive,
      reviewTabOpen,
      startupThreadFallbackActive,
      preserveStartupThreadFallback,
      messageListEmptyState: chat.messageListEmptyState,
      selectedThreadUiStatus: chat.selectedThreadUiStatus,
      selectedThreadMissingFromCollection,
      routeThreadMissingFromCollection,
    };
    const signature = JSON.stringify(tabShellState);
    if (lastLoggedTabShellStateRef.current === signature) {
      return;
    }
    lastLoggedTabShellStateRef.current = signature;

    debugLog("workspace.tabShell", "state.changed", {
      ...tabShellState,
      threadCount: threadIds.length,
      fileTabCount: fileTabPaths.length,
      terminalTabCount: terminalTabIds.length,
      selectedThreadTitle,
      selectedRepositoryName: repos.selectedRepository?.name ?? null,
      selectedWorktreeBranch: repos.selectedWorktree?.branch ?? null,
      selectedWorktreeStatus: repos.selectedWorktree?.status ?? null,
      startupSelectionFallbackActive,
      startupRepoFallbackActive,
      startupWorktreeFallbackActive,
    }, {
      threadId: chat.selectedThreadId ?? search.threadId ?? null,
      worktreeId: repos.selectedWorktreeId ?? search.worktreeId ?? null,
      force: selectedThreadMissingFromCollection || routeThreadMissingFromCollection,
    });
  }, [
    activeFilePath,
    activeTerminalTab?.id,
    activeView,
    chat.messageListEmptyState,
    chat.selectedThreadId,
    chat.selectedThreadUiStatus,
    chat.threads,
    preserveStartupThreadFallback,
    repos.selectedRepository?.name,
    repos.selectedRepositoryId,
    repos.selectedWorktree?.branch,
    repos.selectedWorktree?.status,
    repos.selectedWorktreeId,
    reviewTabOpen,
    search.repoId,
    search.threadId,
    search.worktreeId,
    selectedTerminalTabsState.tabs,
    selectedThreadShell,
    selectedThreadTitle,
    startupRepoFallbackActive,
    startupSelectionFallbackActive,
    startupThreadFallbackActive,
    startupWorktreeFallbackActive,
    terminalViewActive,
    workspaceFileTabs,
  ]);
  pushStartupRenderProfileSection("workspace-file-editor");

  const sessionShortcutTargets = useMemo(
    () => buildSessionShortcutTargets({
      threads: chat.threads,
      terminalTabs: selectedTerminalTabsState.tabs,
      reviewTabOpen,
      fileTabs: workspaceFileTabs,
    }),
    [chat.threads, reviewTabOpen, selectedTerminalTabsState.tabs, workspaceFileTabs],
  );
  const activeSessionShortcutTarget = useMemo(
    () => getActiveSessionShortcutTarget(sessionShortcutTargets, {
      activeView,
      selectedThreadId: chat.selectedThreadId,
      terminalViewActive,
      activeTerminalTabId: activeTerminalTab?.id ?? null,
      activeFilePath,
    }),
    [
      activeFilePath,
      activeTerminalTab?.id,
      activeView,
      chat.selectedThreadId,
      sessionShortcutTargets,
      terminalViewActive,
    ],
  );

  const handleFocusChatInput = useCallback(() => {
    if (activeView === "file" && !confirmSwitchAwayFromActiveFile()) {
      return;
    }

    if (activeView !== "chat") {
      updateSearch({
        view: undefined,
        file: undefined,
        fileLine: undefined,
        fileColumn: undefined,
        automationId: undefined,
        automationCreate: undefined,
      });
    }

    setFocusComposerSignal((current) => current + 1);
  }, [activeView, confirmSwitchAwayFromActiveFile, updateSearch]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen) {
        return;
      }

      const isMac = isMacLikePlatform();

      if (matchesOpenSettingsShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        openSettingsDialog();
        return;
      }

      if (matchesToggleWorkspaceSidebarShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleToggleLeftSidebar();
        return;
      }

      if (matchesFocusChatInputShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleFocusChatInput();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleFocusChatInput, handleToggleLeftSidebar, openSettingsDialog, settingsOpen]);

  const threadlessFallbackSurface = useMemo(
    () => resolveWorkspaceThreadlessFallbackSurface({
      activeTerminalTabId: selectedTerminalTabsState.activeTabId,
      openFilePaths: workspaceFileTabs.map((tab) => tab.path),
      openTerminalTabIds: selectedTerminalTabsState.tabs.map((tab) => tab.id),
      recentFilePaths,
      reviewOpen: activeView === "review",
    }),
    [activeView, recentFilePaths, selectedTerminalTabsState.activeTabId, selectedTerminalTabsState.tabs, workspaceFileTabs],
  );
  const hasOpenContentTabs = threadlessFallbackSurface.kind !== "empty";
  const handleCloseFileTab = useCallback((filePath: string) => {
    const shouldReturnToLanding =
      activeView === "file"
      && activeFilePath === filePath
      && workspaceFileTabs.length <= 1
      && shouldReturnToWorkspaceLandingAfterClosingContent(chat.messageListEmptyState);

    if (shouldReturnToLanding) {
      handleCloseFileTabInternal(filePath, {
        fallbackThreadId: null,
        onBeforeFallbackToChat: () => {
          setWorkspaceLandingHold(repos.selectedWorktreeId, true);
          chat.setSelectedThreadId(null);
        },
      });
      return;
    }

    handleCloseFileTabInternal(filePath);
  }, [
    activeFilePath,
    activeView,
    chat.messageListEmptyState,
    chat.setSelectedThreadId,
    handleCloseFileTabInternal,
    repos.selectedWorktreeId,
    setWorkspaceLandingHold,
    workspaceFileTabs.length,
  ]);

  const handleSelectRepository = useCallback((repositoryId: string) => {
    if (!canDiscardDirtyWorktreeFiles(repos.selectedWorktreeId)) {
      return;
    }

    repos.setSelectedRepositoryId(repositoryId);
    const repository = repos.repositories.find((entry) => entry.id === repositoryId);
    if (!repository) {
      repos.setSelectedWorktreeId(null);
      return;
    }

    const primaryWorktree = findRootWorktree(repository);
    if (primaryWorktree) {
      void prefetchWorktreeNavigationTarget(primaryWorktree.id);
    }
    repos.setSelectedWorktreeId(primaryWorktree?.id ?? null);
  }, [canDiscardDirtyWorktreeFiles, prefetchWorktreeNavigationTarget, repos.repositories, repos.selectedRepositoryId, repos.selectedWorktreeId, repos.setSelectedRepositoryId, repos.setSelectedWorktreeId]);

  const handleSelectWorktree = useCallback((repositoryId: string, worktreeId: string, preferredThreadId?: string | null) => {
    if (!canDiscardDirtyWorktreeFiles(repos.selectedWorktreeId)) {
      return;
    }

    if (mobilePanelOpen === "repos" && repositoryId === repos.selectedRepositoryId && worktreeId === repos.selectedWorktreeId) {
      handleCloseMobileRepositories();
      return;
    }

    const nextMobilePanel = mobilePanelOpen === "repos"
      ? resolveMobileWorktreeTarget(mobileReposOrigin)
      : null;
    const restoredThreadId = preferredThreadId ?? undefined;
    pendingWorktreeSearchSelectionRef.current = {
      repoId: repositoryId,
      worktreeId,
      threadId: restoredThreadId,
    };
    debugLog("workspace.selection.navigation", "worktree.select", {
      repositoryId,
      worktreeId,
      preferredThreadId: preferredThreadId ?? null,
      restoredThreadId: restoredThreadId ?? null,
      previousRepositoryId: repos.selectedRepositoryId,
      previousWorktreeId: repos.selectedWorktreeId,
      previousRouteRepoId: search.repoId ?? null,
      previousRouteWorktreeId: search.worktreeId ?? null,
      previousRouteThreadId: search.threadId ?? null,
      mobilePanelOpen,
    }, { threadId: restoredThreadId ?? null, worktreeId, force: true });
    void prefetchWorktreeNavigationTarget(worktreeId, restoredThreadId);

    repos.setSelectedRepositoryId(repositoryId);
    repos.setSelectedWorktreeId(worktreeId);
    updateSearch({
      repoId: repositoryId,
      worktreeId,
      threadId: restoredThreadId,
      view: undefined,
      file: undefined,
    });

    if (mobilePanelOpen === "repos") {
      setMobilePanelOpen(nextMobilePanel);
      setMobileReposOrigin(null);
    }
  }, [canDiscardDirtyWorktreeFiles, handleCloseMobileRepositories, mobilePanelOpen, mobileReposOrigin, prefetchWorktreeNavigationTarget, repos.selectedRepositoryId, repos.selectedWorktreeId, repos.setSelectedRepositoryId, repos.setSelectedWorktreeId, search.repoId, search.threadId, search.worktreeId, updateSearch]);

  const handleCreateWorktree = useCallback(async (repositoryId: string) => {
    const worktree = await repos.submitWorktree(repositoryId, { select: false });
    if (!worktree) {
      return;
    }

    pendingWorktreeSearchSelectionRef.current = {
      repoId: repositoryId,
      worktreeId: worktree.id,
    };
    debugLog("workspace.selection.navigation", "worktree.create.select", {
      repositoryId,
      worktreeId: worktree.id,
      previousRepositoryId: repos.selectedRepositoryId,
      previousWorktreeId: repos.selectedWorktreeId,
      previousRouteRepoId: search.repoId ?? null,
      previousRouteWorktreeId: search.worktreeId ?? null,
      previousRouteThreadId: search.threadId ?? null,
    }, { worktreeId: worktree.id, force: true });
    void prefetchWorktreeNavigationTarget(worktree.id);

    repos.setSelectedRepositoryId(repositoryId);
    repos.setSelectedWorktreeId(worktree.id);
    updateSearch({
      repoId: repositoryId,
      worktreeId: worktree.id,
      threadId: undefined,
      view: undefined,
      file: undefined,
    });
  }, [
    prefetchWorktreeNavigationTarget,
    repos.selectedRepositoryId,
    repos.selectedWorktreeId,
    repos.setSelectedRepositoryId,
    repos.setSelectedWorktreeId,
    repos.submitWorktree,
    search.repoId,
    search.threadId,
    search.worktreeId,
    updateSearch,
  ]);

  const handleResourceMonitorSelectWorktree = useCallback((repositoryId: string, worktreeId: string) => {
    handleSelectWorktree(repositoryId, worktreeId);
  }, [handleSelectWorktree]);

  const handleResourceMonitorSelectSession = useCallback((repositoryId: string, worktreeId: string, tab: "terminal" | "run") => {
    handleSelectWorktree(repositoryId, worktreeId);
    updateBottomPanelState(worktreeId, (current) => ({
      ...current,
      activeTab: tab,
      collapsed: false,
      openSignal: current.openSignal + 1,
    }));
  }, [handleSelectWorktree, updateBottomPanelState]);

  // Close mobile drawer on Escape key
  useEffect(() => {
    if (!mobilePanelOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }

      if (mobilePanelOpen === "repos") {
        handleCloseMobileRepositories();
        return;
      }

      setMobilePanelOpen(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleCloseMobileRepositories, mobilePanelOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const viewport = window.visualViewport;
    const navigatorWithKeyboard = window.navigator as Navigator & {
      virtualKeyboard?: EventTarget & {
        boundingRect?: DOMRectReadOnly;
      };
    };
    const virtualKeyboard = navigatorWithKeyboard.virtualKeyboard;
    const rootElement = document.documentElement;
    const rootStyle = document.documentElement.style;
    let keyboardVisibleRef = false;
    let allowFocusedFallback = false;
    let sawMeasuredKeyboard = false;
    let baseline: MobileKeyboardBaseline = createMobileKeyboardBaseline({
      activeElement: document.activeElement,
      layoutHeight: window.innerHeight,
      layoutWidth: window.innerWidth,
      virtualKeyboardHeight: virtualKeyboard?.boundingRect?.height ?? 0,
      visualHeight: viewport?.height ?? window.innerHeight,
      visualOffsetTop: viewport?.offsetTop ?? 0,
      visualWidth: viewport?.width ?? window.innerWidth,
    });

    const updateKeyboardState = (reason: "init" | "focusin" | "focusout" | "viewport") => {
      const nextState = computeMobileKeyboardState({
        baseline,
        snapshot: {
          activeElement: document.activeElement,
          layoutHeight: window.innerHeight,
          layoutWidth: window.innerWidth,
          virtualKeyboardHeight: virtualKeyboard?.boundingRect?.height ?? 0,
          visualHeight: viewport?.height ?? window.innerHeight,
          visualOffsetTop: viewport?.offsetTop ?? 0,
          visualWidth: viewport?.width ?? window.innerWidth,
        },
      });

      baseline = nextState.baseline;
      rootStyle.setProperty(MOBILE_KEYBOARD_OFFSET_CSS_VAR, `${nextState.bottomInsetPx}px`);

      if (!nextState.activeIsEditable || reason === "focusout") {
        allowFocusedFallback = false;
        sawMeasuredKeyboard = false;
      } else if (nextState.measuredVisible) {
        sawMeasuredKeyboard = true;
        allowFocusedFallback = false;
      } else if (reason === "focusin") {
        allowFocusedFallback = !sawMeasuredKeyboard;
      } else if (sawMeasuredKeyboard) {
        // The editor may keep focus after the user dismisses the soft keyboard.
        // Once measured keyboard geometry collapses back to zero, stop relying on focus fallback.
        allowFocusedFallback = false;
        sawMeasuredKeyboard = false;
      }

      const nextKeyboardVisible = nextState.measuredVisible || (allowFocusedFallback && nextState.activeIsEditable);
      if (keyboardVisibleRef !== nextKeyboardVisible) {
        keyboardVisibleRef = nextKeyboardVisible;
        rootElement.dataset.mobileKeyboardVisible = nextKeyboardVisible ? "true" : "false";
        setMobileKeyboardOffset(nextKeyboardVisible ? 1 : 0);
      }
    };

    const handleViewportChange = () => updateKeyboardState("viewport");
    const handleFocusIn = () => updateKeyboardState("focusin");
    const handleFocusOut = () => updateKeyboardState("focusout");

    updateKeyboardState("init");

    viewport?.addEventListener("resize", handleViewportChange, { passive: true });
    viewport?.addEventListener("scroll", handleViewportChange, { passive: true });
    virtualKeyboard?.addEventListener("geometrychange", handleViewportChange);
    window.addEventListener("resize", handleViewportChange, { passive: true });
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);

    return () => {
      rootStyle.setProperty(MOBILE_KEYBOARD_OFFSET_CSS_VAR, "0px");
      rootElement.dataset.mobileKeyboardVisible = "false";
      viewport?.removeEventListener("resize", handleViewportChange);
      viewport?.removeEventListener("scroll", handleViewportChange);
      virtualKeyboard?.removeEventListener("geometrychange", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, []);
  const openIssueReportDialog = useCallback(() => {
    setIssueReportOpen(true);
  }, []);

  useEffect(() => {
    if (gates.pendingPermissionRequests.length === 0) {
      setActivePermissionRequestId(null);
      return;
    }

    if (
      activePermissionRequestId
      && gates.pendingPermissionRequests.some((request) => request.requestId === activePermissionRequestId)
    ) {
      return;
    }

    const fallbackIndex = activePermissionIndex >= 0
      ? Math.min(activePermissionIndex, gates.pendingPermissionRequests.length - 1)
      : 0;
    const fallbackRequest = gates.pendingPermissionRequests[fallbackIndex] ?? gates.pendingPermissionRequests[0];
    setActivePermissionRequestId(fallbackRequest?.requestId ?? null);
  }, [activePermissionIndex, activePermissionRequestId, gates.pendingPermissionRequests]);

  useEffect(() => {
    if (gates.pendingQuestionRequests.length === 0) {
      setActiveQuestionRequestId(null);
      return;
    }

    if (
      activeQuestionRequestId
      && gates.pendingQuestionRequests.some((request) => request.requestId === activeQuestionRequestId)
    ) {
      return;
    }

    const fallbackIndex = activeQuestionIndex >= 0
      ? Math.min(activeQuestionIndex, gates.pendingQuestionRequests.length - 1)
      : 0;
    const fallbackRequest = gates.pendingQuestionRequests[fallbackIndex] ?? gates.pendingQuestionRequests[0];
    setActiveQuestionRequestId(fallbackRequest?.requestId ?? null);
  }, [activeQuestionIndex, activeQuestionRequestId, gates.pendingQuestionRequests]);

  const waitingAssistantThreadId = chat.waitingAssistant?.threadId ?? null;

  const thinkingActive = useThreadThinkingActive(chat.selectedThreadId);
  const workingStatus = useMemo(
    () => deriveWorkingStatus({
      thinkingActive,
      events: chat.events,
      selectedThreadUiStatus: chat.selectedThreadUiStatus,
      timelineItems: chat.timelineItems,
    }),
    [chat.events, chat.selectedThreadUiStatus, chat.timelineItems, thinkingActive],
  );
  const showThinkingPlaceholder = shouldShowThinkingPlaceholder({
    selectedThreadUiStatus: chat.selectedThreadUiStatus,
    isWaitingForUserGate: gates.isWaitingForUserGate,
    timelineItems: chat.timelineItems,
    workingStatus,
  });
  useEffect(() => {
    if (
      !repos.selectedWorktreeId
      || !selectedWorktreeLandingHold
      || chat.selectedThreadId != null
      || threadlessFallbackSurface.kind === "empty"
    ) {
      return;
    }

    setWorkspaceLandingHold(repos.selectedWorktreeId, false);
  }, [
    chat.selectedThreadId,
    repos.selectedWorktreeId,
    selectedWorktreeLandingHold,
    setWorkspaceLandingHold,
    threadlessFallbackSurface.kind,
  ]);
  const showWorkspaceEmptyState = shouldShowWorkspaceEmptyState({
    activeView,
    hasOpenContentTabs,
    terminalViewActive,
    messageListEmptyState: chat.messageListEmptyState,
  });
  const selectedThreadIdForAttention = chat.selectedThreadIdForData ?? chat.selectedThreadId;
  const chatVisibleForAttention =
    activeView === "chat"
    && !terminalViewActive
    && !mobileInlinePanel
    && !showWorkspaceEmptyState;
  const handleCompletionAttentionEvent = useCompletionAttention({
    generalSettings,
    repositories: repos.repositories,
    selectedThreadId: selectedThreadIdForAttention,
    chatVisible: chatVisibleForAttention,
  });
  pushStartupRenderProfileSection("completion-attention");
  const startupRenderProfileLoggedRef = useRef(false);

  useEffect(() => {
    if (!startupRenderProfileEnabled || startupRenderProfileLoggedRef.current) {
      return;
    }

    startupRenderProfileLoggedRef.current = true;
    debugLog("startup.render.profile", "workspace-page.first-commit", {
      activeView: activeView ?? null,
      sections: startupRenderProfileSections,
      selectedRepositoryId: repos.selectedRepositoryId,
      selectedThreadId: chat.selectedThreadId,
      selectedWorktreeId: repos.selectedWorktreeId,
    }, { force: true });
  }, [
    activeView,
    chat.selectedThreadId,
    repos.selectedRepositoryId,
    repos.selectedWorktreeId,
    startupRenderProfileEnabled,
    startupRenderProfileSections,
  ]);
  const updateGeneralSettings = useCallback((next: GeneralSettings | ((current: GeneralSettings) => GeneralSettings)) => {
    setGeneralSettings((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      return saveGeneralSettings(resolved);
    });
  }, []);

  useEffect(() => {
    const latestEvent = chat.events[chat.events.length - 1];
    if (
      !latestEvent
      || (latestEvent.type !== "chat.completed" && latestEvent.type !== "chat.failed")
      || selectedThreadIdForAttention == null
      || repos.selectedWorktreeId == null
    ) {
      return;
    }

    handleCompletionAttentionEvent({
      eventId: latestEvent.id,
      threadId: selectedThreadIdForAttention,
      worktreeId: repos.selectedWorktreeId,
      type: latestEvent.type,
      threadTitle: typeof latestEvent.payload.threadTitle === "string" ? latestEvent.payload.threadTitle : null,
    });
  }, [
    chat.events,
    handleCompletionAttentionEvent,
    repos.selectedWorktreeId,
    selectedThreadIdForAttention,
  ]);

  useEffect(() => {
    if (
      !repos.selectedWorktreeId
      || activeView !== "chat"
      || terminalViewActive
      || (
        chat.messageListEmptyState !== "no-thread-selected"
        && chat.messageListEmptyState !== "creating-thread"
      )
      || threadlessFallbackSurface.kind === "empty"
    ) {
      return;
    }

    setWorkspaceLandingHold(repos.selectedWorktreeId, false);

    if (threadlessFallbackSurface.kind === "file") {
      updateSearch({
        view: "file",
        file: threadlessFallbackSurface.filePath,
        fileLine: undefined,
        fileColumn: undefined,
        threadId: undefined,
      });
      return;
    }

    if (threadlessFallbackSurface.kind === "terminal") {
      updateTerminalTabsState(repos.selectedWorktreeId, (current) => ({
        ...current,
        activeTabId: current.tabs.some((tab) => tab.id === threadlessFallbackSurface.terminalTabId)
          ? threadlessFallbackSurface.terminalTabId
          : current.activeTabId,
        visible: true,
      }));
      updateSearch({
        view: undefined,
        file: undefined,
        fileLine: undefined,
        fileColumn: undefined,
        threadId: undefined,
      });
      return;
    }

    updateSearch({
      view: "review",
      file: selectedDiffFilePath ?? undefined,
      threadId: undefined,
    });
  }, [
    activeView,
    chat.messageListEmptyState,
    repos.selectedWorktreeId,
    selectedDiffFilePath,
    setWorkspaceLandingHold,
    terminalViewActive,
    threadlessFallbackSurface,
    updateSearch,
    updateTerminalTabsState,
  ]);

  const handleCreateTerminalTab = useCallback(() => {
    const worktreeId = repos.selectedWorktreeId;
    if (!worktreeId || !selectedWorktreeOperational) {
      return;
    }

    if (!confirmSwitchAwayFromActiveFile()) {
      return;
    }

    setError(null);
    updateSearch({ view: undefined, file: undefined });

    void api.createTerminalTab(worktreeId)
      .then((tab) => {
        updateTerminalTabsState(worktreeId, (current) => {
          if (current.tabs.some((existing) => existing.id === tab.id)) {
            return { ...current, activeTabId: tab.id, visible: true };
          }

          return {
            tabs: [...current.tabs, { id: tab.id, sessionId: tab.sessionId, title: tab.title }],
            activeTabId: tab.id,
            visible: true,
          };
        });
        updateBottomPanelState(worktreeId, (current) => ({
          ...current,
          collapsed: true,
        }));
      })
      .catch(() => {
        setError("Failed to open terminal");
      });
  }, [confirmSwitchAwayFromActiveFile, repos.selectedWorktreeId, selectedWorktreeOperational, setError, updateSearch, updateTerminalTabsState, updateBottomPanelState]);

  const handleSelectTerminalTab = useCallback((terminalTabId: string) => {
    const worktreeId = repos.selectedWorktreeId;
    if (!worktreeId) {
      return;
    }

    if (!confirmSwitchAwayFromActiveFile()) {
      return;
    }

    updateSearch({ view: undefined, file: undefined });
    updateTerminalTabsState(worktreeId, (current) => selectWorkspaceTerminalTab({
      terminalTabsState: current,
      bottomPanelState: getBottomPanelState(bottomPanelStateByWorktreeId, worktreeId),
      terminalTabId,
    }).terminalTabsState);
  }, [bottomPanelStateByWorktreeId, confirmSwitchAwayFromActiveFile, repos.selectedWorktreeId, updateSearch, updateTerminalTabsState]);

  const handleRenameTerminalTab = useCallback((terminalTabId: string, title: string) => {
    const worktreeId = repos.selectedWorktreeId;
    if (!worktreeId) {
      return;
    }

    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    // Optimistic rename; the server is the source of truth and a follow-up
    // terminal.tab.updated event will reconcile any divergence. Revert by
    // re-syncing from the server if the request fails.
    updateTerminalTabsState(worktreeId, (current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === terminalTabId ? { ...tab, title: nextTitle } : tab,
      ),
    }));

    void api.renameTerminalTab(terminalTabId, { title: nextTitle }).catch(() => {
      setError("Failed to rename terminal");
      void syncTerminalTabsFromServer();
    });
  }, [repos.selectedWorktreeId, setError, syncTerminalTabsFromServer, updateTerminalTabsState]);

  const handleCloseTerminalTab = useCallback((terminalTabId: string) => {
    const worktreeId = repos.selectedWorktreeId;
    if (!worktreeId) {
      return;
    }

    const shouldReturnToLanding =
      terminalViewActive
      && activeTerminalTab?.id === terminalTabId
      && selectedTerminalTabsState.tabs.length === 1
      && shouldReturnToWorkspaceLandingAfterClosingContent(chat.messageListEmptyState);

    if (shouldReturnToLanding) {
      setWorkspaceLandingHold(worktreeId, true);
      chat.setSelectedThreadId(null);
      updateSearch({ threadId: undefined });
    }

    const { sessionIdToKill } = closeWorkspaceTerminalTab(selectedTerminalTabsState, terminalTabId);

    updateTerminalTabsState(worktreeId, (current) => closeWorkspaceTerminalTab(current, terminalTabId).state);

    if (sessionIdToKill) {
      disposeTerminalRuntime(sessionIdToKill);
      void api.closeTerminalTab(terminalTabId).catch(() => {});
    }
  }, [
    activeTerminalTab?.id,
    chat.messageListEmptyState,
    chat.setSelectedThreadId,
    repos.selectedWorktreeId,
    selectedTerminalTabsState.tabs,
    setWorkspaceLandingHold,
    terminalViewActive,
    updateSearch,
    updateTerminalTabsState,
  ]);

  const handleCreateThreadFromHeader = useCallback(() => {
    if (!confirmSwitchAwayFromActiveFile()) {
      return;
    }

    hideTerminalView(repos.selectedWorktreeId);
    setWorkspaceLandingHold(repos.selectedWorktreeId, false);
    void chat.createAdditionalThread();
  }, [chat.createAdditionalThread, confirmSwitchAwayFromActiveFile, hideTerminalView, repos.selectedWorktreeId, setWorkspaceLandingHold]);

  const handleOpenReview = useCallback(() => {
    if (!confirmSwitchAwayFromActiveFile()) {
      return;
    }
    updateSearch({ file: undefined, view: "review" });
  }, [confirmSwitchAwayFromActiveFile, updateSearch]);

  const handleOpenCommitChanges = useCallback(() => {
    if (!confirmSwitchAwayFromActiveFile() || !repos.selectedWorktreeId) {
      return;
    }

    if (!desktopApp && !isDesktopViewportNow()) {
      setMobilePanelOpen("git");
      return;
    }

    updateSearch({
      file: undefined,
      view: undefined,
      panel: "git",
    });
  }, [confirmSwitchAwayFromActiveFile, desktopApp, repos.selectedWorktreeId, updateSearch]);

  const handleShowMobileChat = useCallback(() => {
    if (!confirmSwitchAwayFromActiveFile()) {
      return;
    }

    hideTerminalView(repos.selectedWorktreeId);
    setMobilePanelOpen(null);
    updateSearch({ view: undefined, file: undefined, threadId: chat.selectedThreadId ?? undefined });
  }, [chat.selectedThreadId, confirmSwitchAwayFromActiveFile, hideTerminalView, repos.selectedWorktreeId, updateSearch]);

  const handleOpenMobileFiles = useCallback(() => {
    if (!repos.selectedWorktreeId) {
      return;
    }

    setMobilePanelOpen("files");
  }, [repos.selectedWorktreeId]);

  const handleOpenMobileGit = useCallback(() => {
    if (!repos.selectedWorktreeId) {
      return;
    }

    setMobilePanelOpen("git");
  }, [repos.selectedWorktreeId]);

  const handleOpenMobileMore = useCallback(() => {
    setMobilePanelOpen("more");
  }, []);

  const handleOpenMobileDevices = useCallback(() => {
    setMobilePanelOpen("device");
  }, []);

  const handleOpenMobileUtilities = useCallback((tab: string) => {
    updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
      ...current,
      activeTab: tab,
      collapsed: false,
    }));
    setMobilePanelOpen("utilities");
  }, [repos.selectedWorktreeId, updateBottomPanelState]);

  const handlePrMrAction = useCallback(async () => {
    if (!repos.selectedRepository || !repos.selectedWorktree) {
      return;
    }

    if (selectedReviewRef) {
      void openExternalUrl(selectedReviewRef.url);
      return;
    }

    const provider = repositoryReviews.data?.provider ?? "unknown";
    const providerLabel = provider === "gitlab" ? "GitLab" : provider === "github" ? "GitHub" : "your git provider";
    const reviewLabel = reviewKind === "mr" ? "MR" : "PR";
    const reviewTool = provider === "gitlab" ? "glab" : "gh";
    const instruction = [
      `Create or open the ${reviewLabel} for the current worktree branch.`,
      "",
      "Context:",
      `- Repository: ${repos.selectedRepository.name}`,
      `- Provider: ${providerLabel}`,
      `- Current branch: ${selectedReviewBranch ?? repos.selectedWorktree.branch}`,
      `- Base branch: ${selectedReviewBaseBranch ?? repos.selectedRepository.defaultBranch}`,
      `- Worktree path: ${repos.selectedWorktree.path}`,
      "",
      "Workflow:",
      `1. Check whether an open ${reviewLabel} already exists for this branch and open/return it instead of creating a duplicate.`,
      "2. Check whether the branch needs to be pushed first, and push it if needed.",
      `3. Use ${reviewTool} to create the ${reviewLabel} targeting ${selectedReviewBaseBranch ?? repos.selectedRepository.defaultBranch}.`,
      "4. Report the resulting review number and URL in this thread.",
      "",
      "Constraints:",
      "- Stay focused on PR/MR creation only.",
      "- Finish only when you have the final review URL/number, or explain the blocker clearly.",
    ].join("\n");

    try {
      await chat.createOrSelectPrMrThreadAndSendMessage(instruction, "default");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start PR creation flow");
    }
  }, [chat, repos.selectedRepository, repos.selectedWorktree, repositoryReviews.data?.provider, reviewKind, selectedReviewBaseBranch, selectedReviewBranch, selectedReviewRef]);

  const handleOpenSelectedWorktreeInApp = useCallback(async () => {
    if (!selectedOpenInApp || !selectedOpenInAppTargetPath || openInAppShortcutBusyRef.current) {
      return;
    }

    openInAppShortcutBusyRef.current = true;
    try {
      await api.openInApp({ appId: selectedOpenInApp.id, targetPath: selectedOpenInAppTargetPath });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open worktree in app");
    } finally {
      openInAppShortcutBusyRef.current = false;
    }
  }, [selectedOpenInApp, selectedOpenInAppTargetPath]);

  const reviewLookupAvailable = !!repositoryReviews.data?.available;
  const prMrActionBusy = !selectedReviewRef && prMrThreadIsActiveOrPending;
  const prMrActionDisabled = (
    !repos.selectedWorktree
    || !selectedWorktreeOperational
    || selectedWorktreeIsBaseBranch
    || (!selectedReviewRef && !reviewLookupAvailable)
    || (!selectedReviewRef && prMrThreadIsActiveOrPending)
  );
  const prMrActionTitle = !repos.selectedWorktree
    ? "Select a worktree before starting a PR/MR thread"
    : !selectedWorktreeOperational
      ? "Wait for the worktree to finish preparing before starting a PR/MR thread"
      : selectedWorktreeIsBaseBranch
        ? "Cannot start a PR/MR thread from the base branch"
        : (!selectedReviewRef && prMrThreadIsActiveOrPending)
          ? "PR/MR thread is already active"
          : (!selectedReviewRef && !reviewLookupAvailable)
            ? (repositoryReviews.data?.unavailableReason ?? "PR/MR creation is unavailable for this worktree")
            : undefined;

  const handleRerunSetup = useCallback(() => {
    const worktreeId = repos.selectedWorktreeId;
    if (!worktreeId || !selectedWorktreeOperational) return;
    setScriptOutputs((prev) => clearLifecycleScriptOutputs(prev, worktreeId));
    updateBottomPanelState(worktreeId, (current) => ({
      ...current,
      activeTab: "setup-script",
      openSignal: current.openSignal + 1,
    }));
    void repos.rerunSetup(worktreeId);
  }, [repos.rerunSetup, repos.selectedWorktreeId, selectedWorktreeOperational, updateBottomPanelState]);

  const resolveActiveRunScriptSessionId = useCallback(() => {
    if (!repos.selectedWorktreeId) {
      return null;
    }

    return getBottomPanelState(bottomPanelStateByWorktreeId, repos.selectedWorktreeId).runScriptSessionId;
  }, [bottomPanelStateByWorktreeId, repos.selectedWorktreeId]);

  const createRunScriptSessionId = useCallback((worktreeId: string) => (
    `${worktreeId}:script-runner:${Date.now().toString(36)}`
  ), []);

  const handleRunScript = useCallback(async () => {
    if (!repos.selectedWorktreeId || !repos.selectedWorktree || !selectedWorktreeOperational) return;
    const runCommands = (repos.selectedRepository?.runScript ?? [])
      .map((command) => command.trim())
      .filter((command) => command.length > 0);
    if (runCommands.length === 0) {
      openSettingsDialog();
      return;
    }
    const shellScript = runCommands.join(" ; ");
    const sessionId = createRunScriptSessionId(repos.selectedWorktreeId);

    try {
      updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
        ...current,
        activeTab: "run",
        openSignal: current.openSignal + 1,
        runScriptActive: true,
        runScriptSessionId: sessionId,
      }));
      await api.runTerminalCommand({
        sessionId,
        command: shellScript,
        cwd: repos.selectedWorktree.path,
        mode: "exec",
      });
    } catch (e) {
      updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
        ...current,
        runScriptActive: false,
      }));
      setError(e instanceof Error ? e.message : "Failed to run script");
    }
  }, [createRunScriptSessionId, repos.selectedWorktreeId, repos.selectedWorktree, repos.selectedRepository, selectedWorktreeOperational, updateBottomPanelState]);

  const handleStopRunScript = useCallback(async () => {
    const sessionId = resolveActiveRunScriptSessionId();
    if (!sessionId) return;
    try {
      updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
        ...current,
        activeTab: "run",
        openSignal: current.openSignal + 1,
      }));
      await api.interruptTerminalSession(sessionId);
      updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
        ...current,
        runScriptActive: false,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop script");
    }
  }, [repos.selectedWorktreeId, resolveActiveRunScriptSessionId, updateBottomPanelState]);

  const selectedBottomPanelState = getBottomPanelState(bottomPanelStateByWorktreeId, repos.selectedWorktreeId);

  const handleToggleRunScript = useCallback(() => {
    if (selectedBottomPanelState.runScriptActive) {
      void handleStopRunScript();
      return;
    }
    void handleRunScript();
  }, [handleRunScript, handleStopRunScript, selectedBottomPanelState.runScriptActive]);

  const handleShowPreviousPermission = useCallback(() => {
    if (activePermissionIndex <= 0) {
      return;
    }

    const previousRequest = gates.pendingPermissionRequests[activePermissionIndex - 1];
    if (previousRequest) {
      setActivePermissionRequestId(previousRequest.requestId);
    }
  }, [activePermissionIndex, gates.pendingPermissionRequests]);

  const handleShowNextPermission = useCallback(() => {
    if (activePermissionIndex < 0 || activePermissionIndex >= gates.pendingPermissionRequests.length - 1) {
      return;
    }

    const nextRequest = gates.pendingPermissionRequests[activePermissionIndex + 1];
    if (nextRequest) {
      setActivePermissionRequestId(nextRequest.requestId);
    }
  }, [activePermissionIndex, gates.pendingPermissionRequests]);

  const handleShowPreviousQuestion = useCallback(() => {
    if (activeQuestionIndex <= 0) {
      return;
    }

    const previousRequest = gates.pendingQuestionRequests[activeQuestionIndex - 1];
    if (previousRequest) {
      setActiveQuestionRequestId(previousRequest.requestId);
    }
  }, [activeQuestionIndex, gates.pendingQuestionRequests]);

  const handleShowNextQuestion = useCallback(() => {
    if (activeQuestionIndex < 0 || activeQuestionIndex >= gates.pendingQuestionRequests.length - 1) {
      return;
    }

    const nextRequest = gates.pendingQuestionRequests[activeQuestionIndex + 1];
    if (nextRequest) {
      setActiveQuestionRequestId(nextRequest.requestId);
    }
  }, [activeQuestionIndex, gates.pendingQuestionRequests]);

  const handleSelectDiffFile = useCallback((filePath: string) => {
    if (!confirmSwitchAwayFromActiveFile()) {
      return;
    }
    updateSearch({ file: filePath, view: "review" });
  }, [confirmSwitchAwayFromActiveFile, updateSearch]);

  const handleCloseReview = useCallback(() => {
    if (shouldReturnToWorkspaceLandingAfterClosingContent(chat.messageListEmptyState)) {
      setWorkspaceLandingHold(repos.selectedWorktreeId, true);
      chat.setSelectedThreadId(null);
      updateSearch({ view: undefined, file: undefined, threadId: undefined });
      return;
    }

    updateSearch({ view: undefined, file: undefined });
  }, [chat.messageListEmptyState, chat.setSelectedThreadId, repos.selectedWorktreeId, setWorkspaceLandingHold, updateSearch]);

  const handleSelectThread = useCallback(
    (threadId: string | null) => {
      if (!confirmSwitchAwayFromActiveFile()) {
        return;
      }
      hideTerminalView(repos.selectedWorktreeId);
      if (threadId != null) {
        setWorkspaceLandingHold(repos.selectedWorktreeId, false);
      }
      debugLog("workspace.selection.navigation", "thread.select", {
        nextThreadId: threadId,
        previousThreadId: chat.selectedThreadId,
        selectedWorktreeId: repos.selectedWorktreeId,
        routeRepoId: search.repoId ?? null,
        routeWorktreeId: search.worktreeId ?? null,
        routeThreadId: search.threadId ?? null,
      }, { threadId, worktreeId: repos.selectedWorktreeId, force: true });
      chat.setSelectedThreadId(threadId);
      updateSearch({ view: undefined, file: undefined, threadId: threadId ?? undefined });
    },
    [chat.selectedThreadId, chat.setSelectedThreadId, confirmSwitchAwayFromActiveFile, hideTerminalView, repos.selectedWorktreeId, search.repoId, search.threadId, search.worktreeId, setWorkspaceLandingHold, updateSearch],
  );

  const handleSelectSessionShortcutTarget = useCallback((target: SessionShortcutTarget) => {
    if (target.kind === "thread") {
      handleSelectThread(target.id);
      return;
    }

    if (target.kind === "terminal") {
      handleSelectTerminalTab(target.id);
      return;
    }

    if (target.kind === "review") {
      if (!confirmSwitchAwayFromActiveFile()) {
        return;
      }
      updateSearch({ view: "review" });
      return;
    }

    handleSelectFileTab(target.path);
  }, [confirmSwitchAwayFromActiveFile, handleSelectFileTab, handleSelectTerminalTab, handleSelectThread, updateSearch]);

  useEffect(() => {
    if (!activeSessionShortcutTarget || sessionCtrlTabCycleRef.current) {
      return;
    }

    sessionShortcutHistoryRef.current = promoteSessionShortcutTarget(
      sessionShortcutHistoryRef.current,
      activeSessionShortcutTarget,
      sessionShortcutTargets,
    );
  }, [activeSessionShortcutTarget, sessionShortcutTargets]);

  useEffect(() => {
    if (!desktopApp) {
      return;
    }

    const commitCtrlTabCycle = () => {
      const cycle = sessionCtrlTabCycleRef.current;
      if (!cycle) {
        return;
      }

      const selectedTarget = cycle.baseHistory[cycle.index];
      if (selectedTarget) {
        sessionShortcutHistoryRef.current = promoteSessionShortcutTarget(
          cycle.baseHistory,
          selectedTarget,
          sessionShortcutTargets,
        );
      }
      sessionCtrlTabCycleRef.current = null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !event.ctrlKey
        || event.metaKey
        || event.altKey
        || event.key !== "Tab"
      ) {
        return;
      }

      const cycle = sessionCtrlTabCycleRef.current;
      const baseHistory = cycle?.baseHistory
        ?? buildSessionShortcutCycleHistory(
          sessionShortcutHistoryRef.current,
          sessionShortcutTargets,
          activeSessionShortcutTarget,
        );
      if (baseHistory.length <= 1) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const direction = event.shiftKey ? "previous" : "next";
      const index = cycle
        ? getWrappedIndex(cycle.index, baseHistory.length, direction)
        : direction === "previous"
          ? baseHistory.length - 1
          : 1;
      const target = baseHistory[index];
      if (!target) {
        return;
      }

      sessionCtrlTabCycleRef.current = { baseHistory, index };
      handleSelectSessionShortcutTarget(target);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control") {
        commitCtrlTabCycle();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", commitCtrlTabCycle);
    document.addEventListener("visibilitychange", commitCtrlTabCycle);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", commitCtrlTabCycle);
      document.removeEventListener("visibilitychange", commitCtrlTabCycle);
    };
  }, [desktopApp, handleSelectSessionShortcutTarget, sessionShortcutTargets]);

  const handleMoveSessionTab = useCallback((direction: "previous" | "next") => {
    const targets = sessionShortcutTargets;
    if (targets.length === 0) {
      return;
    }

    const activeIndex = getActiveSessionShortcutTargetIndex(targets, {
      activeView,
      selectedThreadId: chat.selectedThreadId,
      terminalViewActive,
      activeTerminalTabId: activeTerminalTab?.id ?? null,
      activeFilePath,
    });
    const nextIndex = getWrappedIndex(activeIndex, targets.length, direction);
    const target = targets[nextIndex];
    if (!target) {
      return;
    }

    handleSelectSessionShortcutTarget(target);
  }, [
    activeFilePath,
    activeTerminalTab?.id,
    activeView,
    chat.selectedThreadId,
    handleSelectSessionShortcutTarget,
    sessionShortcutTargets,
    terminalViewActive,
  ]);

  const handleMoveWorktree = useCallback((direction: "previous" | "next") => {
    if (visibleWorktreeShortcutTargets.length === 0) {
      return;
    }

    const activeIndex = visibleWorktreeShortcutTargets.findIndex((target) => (
      target.worktreeId === repos.selectedWorktreeId
    ));
    const nextIndex = getWrappedIndex(activeIndex, visibleWorktreeShortcutTargets.length, direction);
    const target = visibleWorktreeShortcutTargets[nextIndex];
    if (!target) {
      return;
    }

    handleSelectWorktree(target.repositoryId, target.worktreeId);
  }, [handleSelectWorktree, repos.selectedWorktreeId, visibleWorktreeShortcutTargets]);

  const handleJumpToWorktree = useCallback((index: number) => {
    const target = visibleWorktreeShortcutTargets[index];
    if (!target) {
      return;
    }

    handleSelectWorktree(target.repositoryId, target.worktreeId);
  }, [handleSelectWorktree, visibleWorktreeShortcutTargets]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen) {
        return;
      }

      const isMac = isMacLikePlatform();
      const jumpWorktreeIndex = getJumpToWorktreeShortcutIndex(event, isMac);
      const shortcutTargetEditable = isWorkspaceShortcutEditableTarget(event.target);

      if (matchesOpenInAppShortcut(event, isMac)) {
        if (shortcutTargetEditable || !selectedOpenInApp || !selectedOpenInAppTargetPath) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        void handleOpenSelectedWorktreeInApp();
        return;
      }

      if (matchesOpenPullRequestShortcut(event, isMac)) {
        if (shortcutTargetEditable || !selectedReviewRef) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        void handlePrMrAction();
        return;
      }

      if (matchesCreateTerminalShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleCreateTerminalTab();
        return;
      }

      if (matchesCreateThreadShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleCreateThreadFromHeader();
        return;
      }

      if (matchesPreviousSessionTabShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleMoveSessionTab("previous");
        return;
      }

      if (matchesNextSessionTabShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleMoveSessionTab("next");
        return;
      }

      if (matchesPreviousWorktreeShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleMoveWorktree("previous");
        return;
      }

      if (matchesNextWorktreeShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        handleMoveWorktree("next");
        return;
      }

      if (jumpWorktreeIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        handleJumpToWorktree(jumpWorktreeIndex);
        return;
      }

      if (matchesNavigateBackShortcut(event, isMac)) {
        if (!workspaceNavigation.canGoBack || !confirmSwitchAwayFromActiveFile()) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        workspaceNavigation.goBack();
        return;
      }

      if (matchesNavigateForwardShortcut(event, isMac)) {
        if (!workspaceNavigation.canGoForward || !confirmSwitchAwayFromActiveFile()) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        workspaceNavigation.goForward();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    confirmSwitchAwayFromActiveFile,
    handleCreateTerminalTab,
    handleCreateThreadFromHeader,
    handleOpenSelectedWorktreeInApp,
    handleJumpToWorktree,
    handleMoveSessionTab,
    handleMoveWorktree,
    handlePrMrAction,
    selectedOpenInApp,
    selectedOpenInAppTargetPath,
    selectedReviewRef,
    settingsOpen,
    workspaceNavigation,
  ]);

  const openThreads = useMemo(
    () => chat.threads.filter((thread) => thread.tabOpen ?? true),
    [chat.threads],
  );
  const closedThreads = useMemo(
    () => chat.threads
      .filter((thread) => (thread.tabOpen ?? true) === false)
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [chat.threads],
  );

  const handleRequestDeleteThread = useCallback((threadId: string) => {
    setConfirmDeleteThreadId(threadId);
  }, []);

  const handleConfirmDeleteThread = useCallback(async () => {
    if (!confirmDeleteThreadId) return;
    await chat.deleteThreadPermanently(confirmDeleteThreadId);
    setConfirmDeleteThreadId(null);
  }, [chat.deleteThreadPermanently, confirmDeleteThreadId]);

  const handleRequestCloseThread = useCallback((threadId: string) => {
    const needsConfirm = shouldConfirmCloseThread({
      threadId,
      selectedThreadId: chat.selectedThreadId,
      showStopAction: chat.showStopAction,
      waitingAssistantThreadId,
      threads: chat.threads,
    });

    if (needsConfirm) {
      setConfirmCloseThreadId(threadId);
      return;
    }

    void chat.closeThread(threadId);
  }, [chat.closeThread, chat.selectedThreadId, chat.showStopAction, chat.threads, waitingAssistantThreadId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey !== true || event.ctrlKey || event.key.toLowerCase() !== "w") {
        return;
      }

      const closeTarget = resolveMacCloseShortcutTarget({
        activeView,
        selectedThreadId: chat.selectedThreadId,
        activeTerminalTabId: terminalViewActive ? activeTerminalTab?.id ?? null : null,
        activeFilePath,
        threadCount: chat.threads.length,
        messageListEmptyState: chat.messageListEmptyState,
      });

      if (!closeTarget) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (closeTarget === "file") {
        if (activeFilePath) {
          handleCloseFileTab(activeFilePath);
        }
        return;
      }

      if (closeTarget === "review") {
        handleCloseReview();
        return;
      }

      if (closeTarget === "terminal") {
        if (activeTerminalTab) {
          handleCloseTerminalTab(activeTerminalTab.id);
        }
        return;
      }

      if (closeTarget === "automations") {
        updateSearch({ view: undefined });
        return;
      }

      if (chat.closingThreadId || !repos.selectedWorktreeId || !chat.selectedThreadId) {
        return;
      }

      handleRequestCloseThread(chat.selectedThreadId);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeFilePath,
    activeTerminalTab,
    activeView,
    chat.closingThreadId,
    chat.messageListEmptyState,
    chat.selectedThreadId,
    chat.threads.length,
    handleCloseFileTab,
    handleCloseTerminalTab,
    handleCloseReview,
    handleRequestCloseThread,
    repos.selectedWorktreeId,
    terminalViewActive,
    updateSearch,
  ]);

  const handleConfirmCloseThread = useCallback(async () => {
    if (!confirmCloseThreadId) return;
    const threadId = confirmCloseThreadId;
    const targetThread = chat.threads.find((thread) => thread.id === threadId) ?? null;
    const shouldStopFirst = !!targetThread?.active || waitingAssistantThreadId === threadId;

    if (shouldStopFirst) {
      await chat.stopAssistantRun(threadId);
      return;
    }

    await chat.closeThread(threadId);
    setConfirmCloseThreadId(null);
  }, [chat.closeThread, chat.stopAssistantRun, chat.threads, confirmCloseThreadId, waitingAssistantThreadId]);

  const confirmCloseThread = confirmCloseThreadId
    ? chat.threads.find((thread) => thread.id === confirmCloseThreadId) ?? null
    : null;
  const confirmDeleteThread = confirmDeleteThreadId
    ? chat.threads.find((thread) => thread.id === confirmDeleteThreadId) ?? null
    : null;
  const closingConfirmedThread =
    confirmCloseThreadId !== null && chat.closingThreadId === confirmCloseThreadId;
  const confirmCloseNeedsStop =
    confirmCloseThreadId !== null && (
      waitingAssistantThreadId === confirmCloseThreadId
      || chat.threads.some((thread) => thread.id === confirmCloseThreadId && thread.active)
    );
  const shouldRenderMobileRepositories = !desktopApp && (!desktopLayout || mobileReposDrawerOpen);
  const resourceMonitorControl = desktopApp ? (
    <Suspense fallback={null}>
      <ResourceMonitor
        desktopApp={desktopApp}
        runtimePid={runtimeInfo.data?.pid ?? null}
        repositories={orderedRepositories}
        popoverAlign={showMacDesktopTitleBar ? "start" : "end"}
        triggerVariant={showMacDesktopTitleBar ? "titlebar" : "default"}
        onSelectWorktree={handleResourceMonitorSelectWorktree}
        onSelectSession={handleResourceMonitorSelectSession}
      />
    </Suspense>
  ) : null;
  const workspaceHeaderControls = resourceMonitorControl;
  const visibleLiveError = liveError && dismissedLiveErrorSignature !== liveError.signature
    ? liveError
    : null;

  return (
    <div
      className={cn(
        "flex h-full p-1 pb-0 sm:p-2 sm:pb-0 lg:p-0",
        !showMacDesktopTitleBar && "safe-top",
      )}
    >
      <div className="flex min-h-0 w-full flex-col">
        {showMacDesktopTitleBar ? (
          <Suspense fallback={null}>
            <MacDesktopTitleBar
              desktopApp={desktopApp}
              resourceMonitor={workspaceHeaderControls}
              canGoBack={workspaceNavigation.canGoBack}
              canGoForward={workspaceNavigation.canGoForward}
              leftPanelVisible={leftSidebarVisible}
              onGoBack={workspaceNavigation.goBack}
              onGoForward={workspaceNavigation.goForward}
              onToggleLeftPanel={handleToggleLeftSidebar}
            />
          </Suspense>
        ) : null}

        <div className="flex min-h-0 w-full flex-1">
          <Suspense
            fallback={(
              <WorkspaceSidebarShell
                desktopApp={desktopApp}
                repositoryName={resolvedStartupRepositoryName}
                worktreeBranch={resolvedStartupWorktreeBranch}
                selectedIsRootWorkspace={selectedIsRootWorkspace}
                isVisible={leftSidebarVisible}
              />
            )}
          >
            <WorkspaceSidebar
              desktopApp={desktopApp}
              repositories={orderedRepositories}
              selectedRepositoryId={repos.selectedRepositoryId}
              selectedWorktreeId={repos.selectedWorktreeId}
              selectedWorktreeStatusOverride={selectedWorktreeStatusOverride}
              worktreeStatusOverrides={worktreeStatusOverrides}
              threadSnapshot={backgroundStatusThreadSnapshot}
              hiddenRepositoryIds={hiddenRepositoryIds}
              expandedByRepo={expandedByRepo}
              loadingRepos={repos.loadingRepos}
              submittingRepo={repos.submittingRepo}
              submittingWorktree={repos.submittingWorktree}
              automationActive={activeView === "automations"}
              enableRepositoryMetadata={enableNonCriticalWorkspaceData}
              enableWorktreeStatuses={enableSidebarWorktreeStatuses}
              isVisible={leftSidebarVisible}
              onOpenAutomations={() => {
                updateSearch({
                  view: "automations",
                  automationId: undefined,
                  automationCreate: undefined,
                }, { replace: false });
              }}
              onOpenSettings={openSettingsDialog}
              onAttachRepository={repos.openFileBrowser}
              onSelectRepository={handleSelectRepository}
              onToggleRepositoryExpand={handleToggleRepositoryExpand}
              onSetRepositoryVisibility={handleSetRepositoryVisibility}
              onShowAllRepositories={handleShowAllRepositories}
              onReorderRepositories={handleReorderRepositories}
              onCreateWorktree={handleCreateWorktree}
              onSelectWorktree={handleSelectWorktree}
              onDeleteWorktree={repos.removeWorktree}
              onRenameWorktreeBranch={repos.renameWorktreeBranch}
              onPrefetchWorktree={prefetchWorktreeNavigationTarget}
            />
          </Suspense>

          {/* ── Main content area (chat + bottom panel) ── */}
          <main
            className={getWorkspaceMainClassName({
              activeView,
              mobileReposOverlayOpen,
            })}
            aria-hidden={mobileReposOverlayOpen ? "true" : undefined}
          >
          {/* ── Mobile top bar ── */}
          {!desktopApp ? (
            <div
              className={cn(
                "flex items-center gap-2.5 px-1.5 pb-1.5 pt-1.5 lg:hidden sm:px-2.5 sm:pt-2.5",
                mobileUtilitiesFullscreen && "hidden",
              )}
            >
              <button
                type="button"
                onClick={handleOpenMobileRepositories}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-secondary/35 text-foreground transition-colors active:bg-secondary/60"
                aria-label="Open repositories"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[13px] font-semibold leading-5 tracking-wide text-foreground">{mobileTitle}</h1>
                <p className="truncate text-[10px] leading-4 text-muted-foreground">{mobileSubtitle}</p>
              </div>
              <button
                type="button"
                onClick={handleToggleRunScript}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-secondary/35 text-foreground transition-colors active:bg-secondary/60 disabled:opacity-40"
                aria-label={selectedBottomPanelState.runScriptActive ? "Stop script" : "Run script"}
                title={selectedBottomPanelState.runScriptActive ? "Stop script" : "Run script"}
                disabled={!repos.selectedWorktreeId || !selectedWorktreeOperational}
              >
                {selectedBottomPanelState.runScriptActive ? (
                  <FilledPauseIcon className="h-3.5 w-3.5" />
                ) : (
                  <FilledPlayIcon className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ) : null}

          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col gap-0",
            )}
          >
            {showWorkspaceHeader ? (
              <div
                className={cn(
                  getWorkspaceHeaderContainerClassName({
                    activeView,
                  }),
                  mobileInlinePanel && !desktopApp && "hidden lg:block",
                )}
              >
                <Suspense
                  fallback={(
                    <WorkspaceHeaderShell
                      desktopApp={desktopApp}
                      selectedWorktreeBranch={resolvedStartupWorktreeBranch}
                      selectedIsRootWorkspace={selectedIsRootWorkspace}
                      targetBranch={selectedTargetBranch}
                      selectedTabLabel={workspaceHeaderSelectedTabLabel}
                      leftPanelVisible={leftSidebarVisible}
                      onToggleLeftPanel={showMacDesktopTitleBar ? undefined : handleToggleLeftSidebar}
                    />
                  )}
                >
                  <WorkspaceHeader
                    desktopApp={desktopApp}
                    selectedWorktreeBranch={resolvedStartupWorktreeBranch}
                    selectedIsRootWorkspace={selectedIsRootWorkspace}
                    targetBranch={selectedTargetBranch}
                    targetBranchOptions={repositoryBranches.data ?? []}
                    targetBranchLoading={
                      repositoryBranches.isLoading
                      || repositoryBranches.isFetching
                      || repos.updatingTargetBranchWorktreeId === repos.selectedWorktreeId
                    }
                    targetBranchDisabled={
                      !repos.selectedWorktreeId
                      || !selectedWorktreeOperational
                      || !repos.selectedRepositoryId
                      || repos.updatingTargetBranchWorktreeId === repos.selectedWorktreeId
                    }
                    enableInstalledAppsQuery={enableNonCriticalWorkspaceData}
                    worktreePath={selectedWorktreeOperational ? (repos.selectedWorktree?.path ?? null) : resolvedStartupWorktreePath}
                    threads={openThreads}
                    closedThreads={closedThreads}
                    terminalTabs={selectedTerminalTabsState.tabs}
                    activeTerminalTabId={activeTerminalTab?.id ?? null}
                    terminalTabActive={terminalViewActive}
                    selectedThreadId={chat.selectedThreadId}
                    selectedThreadFallbackTitle={selectedThreadTitle}
                    fileTabs={workspaceFileTabs}
                    activeFilePath={activeFilePath}
                    disabled={!repos.selectedWorktreeId || !selectedWorktreeOperational}
                    createThreadDisabled={!repos.selectedWorktreeId || !selectedWorktreeOperational || chat.sendingMessage}
                    createTerminalDisabled={!repos.selectedWorktreeId || !selectedWorktreeOperational}
                    closingThreadId={chat.closingThreadId}
                    protectedThreadId={chat.showStopAction ? chat.selectedThreadId : null}
                    showReviewTab={reviewTabOpen}
                    reviewTabActive={activeView === "review"}
                    onSelectThread={handleSelectThread}
                    onSelectTerminalTab={handleSelectTerminalTab}
                    onPrefetchThread={(threadId) => {
                      void prefetchDisplayThreadSnapshot(threadId);
                    }}
                    onSelectFileTab={handleSelectFileTab}
                    onPinFileTab={handlePinFileTab}
                    onCloseFileTab={handleCloseFileTab}
                    onCreateThread={handleCreateThreadFromHeader}
                    onCreateTerminal={handleCreateTerminalTab}
                    onCloseThread={handleRequestCloseThread}
                    onReopenThread={(threadId) => void chat.reopenThread(threadId)}
                    onDeleteThread={handleRequestDeleteThread}
                    onCloseTerminalTab={handleCloseTerminalTab}
                    onRenameTerminalTab={handleRenameTerminalTab}
                    onRenameThread={(threadId, title) => chat.renameThreadTitle(threadId, title)}
                    onSelectTargetBranch={(branch) => {
                      if (!repos.selectedWorktreeId) {
                        return;
                      }
                      void repos.updateWorktreeTargetBranch(repos.selectedWorktreeId, branch);
                    }}
                    onSelectReviewTab={() => {
                      if (!confirmSwitchAwayFromActiveFile()) {
                        return;
                      }
                      updateSearch({ view: "review" });
                    }}
                    onCloseReviewTab={handleCloseReview}
                    runScriptRunning={selectedBottomPanelState.runScriptActive}
                    onToggleRunScript={handleToggleRunScript}
                    leftPanelVisible={leftSidebarVisible}
                    onToggleLeftPanel={showMacDesktopTitleBar ? undefined : handleToggleLeftSidebar}
                    mergeWithContent={activeView === "file"}
                    resourceMonitor={!showMacDesktopTitleBar ? workspaceHeaderControls : null}
                  />
                </Suspense>

                {uiError ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                    <strong>!</strong> {uiError}
                  </div>
                ) : null}

                {startupBannerSnapshot ? (
                  <StartupStatusBanner
                    runtimeState={startupState.runtimeState}
                    snapshot={startupBannerSnapshot}
                    className="mx-3 mb-3 mt-2"
                  />
                ) : null}
              </div>
            ) : null}

            {!desktopApp && mobilePanelOpen === "files" ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:hidden">
                <Suspense fallback={null}>
                  <MobileFilesSheet
                    open
                    onOpenChange={(open) => {
                      if (!open) {
                        setMobilePanelOpen(null);
                      }
                    }}
                    worktreeId={repos.selectedWorktreeId}
                    activeFilePath={activeFilePath}
                    fileTabs={workspaceFileTabs}
                    recentFilePaths={recentFilePaths}
                    fileEntries={fileIndex.entries}
                    loading={fileIndex.loading}
                    pending={selectedWorktreePending}
                    onOpenFile={(path) => {
                      void openReadFile(path);
                    }}
                    onCloseFile={handleCloseFileTab}
                  />
                </Suspense>
              </section>
            ) : !desktopApp && mobilePanelOpen === "git" ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:hidden">
                <Suspense fallback={null}>
                  <MobileGitSheet
                    open
                    onOpenChange={(open) => {
                      if (!open) {
                        setMobilePanelOpen(null);
                      }
                    }}
                    entries={gitChanges.entries}
                    branch={displayGitBranch}
                    loading={selectedWorktreePending || gitChanges.loading}
                    committing={gitChanges.committing}
                    syncing={gitChanges.syncing}
                    canSync={gitChanges.canSync}
                    ahead={gitChanges.ahead}
                    behind={gitChanges.behind}
                    error={gitChanges.error}
                    selectedFilePath={selectedDiffFilePath}
                    onCommit={(msg) => void gitChanges.commit(msg)}
                    onSync={() => void gitChanges.sync()}
                    onReview={() => {
                      handleOpenReview();
                      setMobilePanelOpen(null);
                    }}
                    onRefresh={() => void gitChanges.refresh()}
                    onSelectFile={(path) => {
                      handleSelectDiffFile(path);
                      setMobilePanelOpen(null);
                    }}
                    onDiscardChange={(path) => void gitChanges.discardChange(path)}
                    onOpenFile={(path) => {
                      void openReadFile(path);
                      setMobilePanelOpen(null);
                    }}
                    reviewKind={repositoryReviews.data?.kind ?? null}
                    reviewRef={selectedReviewRef}
                    prMrActionDisabled={prMrActionDisabled}
                    prMrActionTitle={prMrActionTitle}
                    prMrActionBusy={prMrActionBusy}
                    onPrMrAction={() => {
                      setMobilePanelOpen(null);
                      void handlePrMrAction();
                    }}
                  />
                </Suspense>
              </section>
            ) : !desktopApp && mobilePanelOpen === "more" ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:hidden">
                <Suspense fallback={null}>
                  <MobileMoreSheet
                    open
                    onOpenChange={(open) => {
                      if (!open) {
                        setMobilePanelOpen(null);
                      }
                    }}
                    hasWorktree={!!repos.selectedWorktreeId}
                    runScriptActive={selectedBottomPanelState.runScriptActive}
                    onOpenRepositories={handleOpenMobileRepositories}
                    onOpenDevices={handleOpenMobileDevices}
                    onOpenSettings={() => {
                      setMobilePanelOpen(null);
                      openSettingsDialog();
                    }}
                    onOpenIssueReport={() => {
                      setMobilePanelOpen(null);
                      openIssueReportDialog();
                    }}
                    onOpenUtility={(tab) => handleOpenMobileUtilities(tab)}
                  />
                </Suspense>
              </section>
            ) : !desktopApp && mobilePanelOpen === "device" ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:hidden">
                <Suspense fallback={null}>
                  <DevicePanel onClose={() => setMobilePanelOpen(null)} />
                </Suspense>
              </section>
            ) : !desktopApp && mobilePanelOpen === "utilities" ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden lg:hidden">
                <Suspense fallback={null}>
                  <MobileUtilitiesSheet
                    open
                    onOpenChange={(open) => {
                      if (!open) {
                        setMobilePanelOpen(null);
                      }
                    }}
                    onBack={() => setMobilePanelOpen("more")}
                    worktreeId={selectedWorktreeOperational ? repos.selectedWorktreeId : null}
                    worktreePath={selectedWorktreeOperational ? (repos.selectedWorktree?.path ?? null) : null}
                    scriptOutputs={scriptOutputs}
                    activeTab={selectedBottomPanelState.activeTab}
                    onRerunSetup={handleRerunSetup}
                    runScriptActive={selectedBottomPanelState.runScriptActive}
                    runScriptSessionId={selectedBottomPanelState.runScriptSessionId}
                    onRunScriptExit={(event) => handleRunScriptTerminalExit(event, repos.selectedWorktreeId)}
                    bottomOffset={mobileKeyboardOffset}
                  />
                </Suspense>
              </section>
            ) : terminalViewActive && activeTerminalTab && repos.selectedWorktreeId && selectedWorktreeOperational ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex min-h-0 flex-1 overflow-hidden bg-[#0f1218]">
                  <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">Loading terminal...</div>}>
                    <WorkspaceTerminalSurface
                      key={activeTerminalTab.id}
                      sessionId={activeTerminalTab.sessionId}
                      cwd={repos.selectedWorktree?.path ?? null}
                      mobileBottomOffset={mobileKeyboardOffset}
                      onOpenFile={(path) => void openReadFile(path)}
                      showMobileKeyboardToolbar={!desktopLayout}
                    />
                  </Suspense>
                </div>
              </section>
            ) : activeView === "review" && reviewTabOpen && repos.selectedWorktreeId && selectedWorktreeOperational ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading review...</div>}>
                  <DiffReviewPanel worktreeId={repos.selectedWorktreeId} selectedFilePath={selectedDiffFilePath} />
                </Suspense>
              </section>
            ) : activeView === "file" && activeFilePath ? (
              <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading editor...</div>}>
                  <CodeEditorPanel
                    key={`${repos.selectedWorktreeId ?? "none"}:${activeFilePath}`}
                    filePath={activeFilePath}
                    externalFile={activeFileExternal}
                    targetLine={activeFileLine ?? undefined}
                    targetColumn={activeFileColumn ?? undefined}
                    fileEntries={fileIndex.entries}
                    content={activeEditorFileState?.draftContent ?? ""}
                    mimeType={activeEditorFileState?.mimeType ?? "text/plain"}
                    gitHeadContent={activeEditorGitBaselineState?.headContent ?? null}
                    gitBaselineReady={activeEditorGitBaselineState?.loaded ?? false}
                    gitBaselineLoading={activeEditorGitBaselineState?.loading ?? false}
                    gitBranch={gitChanges.branch}
                    gitStatus={activeGitChangeEntry?.status ?? null}
                    loading={activeEditorFileState?.loading ?? false}
                    saving={activeEditorFileState?.saving ?? false}
                    dirty={activeFileDirty}
                    error={activeEditorFileState?.error ?? null}
                    desktopApp={desktopApp}
                    mobileBottomOffset={mobileKeyboardOffset}
                    onChange={(content) => handleEditorDraftChange(activeFilePath, content)}
                    onSave={() => void handleSaveActiveFile()}
                    onRetry={handleRetryActiveFileLoad}
                    onOpenFile={(path) => void openReadFile(path)}
                  />
                </Suspense>
              </section>
            ) : activeView === "automations" ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading automations...</div>}>
                  <WorkspaceAutomationsPanel
                    automationId={search.automationId ?? null}
                    create={search.automationCreate === true}
                    prefills={{
                      repositoryId: repos.selectedRepositoryId ?? undefined,
                      worktreeId: repos.selectedWorktreeId ?? undefined,
                      agent: selectedChatThread?.agent,
                      model: selectedChatThread?.model,
                      permissionMode: selectedChatThread?.permissionMode,
                      chatMode: selectedChatThread?.mode,
                    }}
                    onOpenAutomation={(automationId) => {
                      updateSearch({
                        view: "automations",
                        automationId,
                        automationCreate: undefined,
                      });
                    }}
                    onBack={() => {
                      updateSearch({
                        view: "automations",
                        automationId: undefined,
                        automationCreate: undefined,
                      });
                    }}
                    onOpenRun={(run, repositoryId) => {
                      handleSelectWorktree(repositoryId, run.worktreeId, run.threadId);
                    }}
                    onCreateDialogOpenChange={(open) => {
                      updateSearch({
                        view: "automations",
                        automationId: undefined,
                        automationCreate: open ? true : undefined,
                      });
                    }}
                  />
                </Suspense>
              </section>
            ) : showWorkspaceEmptyState ? (
              <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">Loading workspace…</div>}>
                <WorkspaceEmptyState
                  repositoryName={resolvedStartupRepositoryName}
                  worktreeBranch={resolvedStartupWorktreeBranch}
                  worktreePath={resolvedStartupWorktreePath}
                  enableInstalledAppsQuery={enableNonCriticalWorkspaceData}
                  hasWorktree={!!(repos.selectedWorktreeId || (startupWorktreeFallbackActive && startupSnapshot?.worktreeId))}
                  worktreeReady={selectedWorktreeOperational}
                  preparingThread={chat.messageListEmptyState === "creating-thread"}
                  gitChangeCount={gitChanges.entries.length}
                  recentFilePaths={recentFilePaths}
                  reviewKind={repositoryReviews.data?.kind ?? null}
                  reviewRef={selectedReviewRef}
                  canCreateThread={!!repos.selectedWorktreeId && selectedWorktreeOperational && !chat.sendingMessage}
                  canOpenFiles={!!repos.selectedWorktreeId && selectedWorktreeOperational}
                  canCreateTerminal={!!repos.selectedWorktreeId && selectedWorktreeOperational}
                  canOpenCommitChanges={!!repos.selectedWorktreeId && selectedWorktreeOperational && gitChanges.entries.length > 0}
                  showRevealRepositoriesAction={!leftSidebarVisible}
                  onCreateThread={handleCreateThreadFromHeader}
                  onOpenFilePicker={openQuickFilePicker}
                  onCreateTerminal={handleCreateTerminalTab}
                  onOpenCommitChanges={handleOpenCommitChanges}
                  onOpenPullRequest={handlePrMrAction}
                  onRevealRepositories={handleRevealRepositories}
                  onOpenRecentFile={(path) => {
                    void openReadFile(path);
                  }}
                />
              </Suspense>
            ) : (
              <>
                <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="min-h-0 min-w-0 flex-1">
                    <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading conversation...</div>}>
                      <ChatMessageList
                        threadId={chat.selectedThreadId}
                        items={chat.timelineItems}
                        emptyState={chat.messageListEmptyState}
                        showThinkingPlaceholder={showThinkingPlaceholder}
                        workingStatus={workingStatus}
                        onOpenReadFile={openReadFile}
                        worktreePath={selectedWorktreeOperational ? (repos.selectedWorktree?.path ?? null) : null}
                        footer={gates.showPlanDecisionComposer ? (
                          <Suspense fallback={null}>
                            <PlanDecisionComposer
                              busy={gates.planActionBusy}
                              currentSelection={{
                                agent: chat.composerAgent,
                                model: chat.composerModel,
                                modelProviderId: chat.composerModelProviderId,
                              }}
                              threadKind={selectedChatThread?.kind ?? null}
                              hasMessages={chat.messages.length > 0}
                              providers={modelProviders}
                              claudeModels={claudeModels}
                              codexModels={codexModels}
                              cursorModels={cursorModels}
                              opencodeModels={opencodeModels}
                              modelCatalogReadyByAgent={modelCatalogReadyByAgent}
                              runtimeInfo={runtimeInfo.data ?? null}
                              onAgentModelSelectorOpen={handleOpenAgentModelSelector}
                              onApprove={(selection) => void gates.handleApprovePlan(selection)}
                              onRevise={(feedback) => void gates.handleRevisePlan(feedback)}
                              onDismiss={() => void gates.handleDismissPlan()}
                            />
                          </Suspense>
                        ) : null}
                      />
                    </Suspense>
                  </div>
                </section>
                {showPermissionGate ? (
                  <section className="mx-auto w-full max-w-3xl px-3" data-testid="permission-prompts-container">
                    <div className="space-y-2">
                      {hasMultiplePendingPermissions ? (
                        activePermissionRequest ? (
                          <Suspense fallback={null}>
                            <PermissionPromptCard
                              key={activePermissionRequest.requestId}
                              requestId={activePermissionRequest.requestId}
                              toolName={activePermissionRequest.toolName}
                              command={activePermissionRequest.command}
                              editTarget={activePermissionRequest.editTarget}
                              blockedPath={activePermissionRequest.blockedPath}
                              decisionReason={activePermissionRequest.decisionReason}
                              busy={gates.resolvingPermissionIds.has(activePermissionRequest.requestId)}
                              canAlwaysAllow={activePermissionRequest.canAlwaysAllow}
                              alwaysAllowScope={activePermissionRequest.alwaysAllowScope}
                              alwaysAllowDescription={activePermissionRequest.alwaysAllowDescription}
                              position={{
                                current: activePermissionIndex + 1,
                                total: gates.pendingPermissionRequests.length,
                              }}
                              onPrevious={handleShowPreviousPermission}
                              onNext={handleShowNextPermission}
                              onAllowOnce={(requestId) => void gates.resolvePermission(requestId, "allow")}
                              onAllowAlways={(requestId) => void gates.resolvePermission(requestId, "allow_always")}
                              onDeny={(requestId) => {
                                void gates.resolvePermission(requestId, "deny");
                              }}
                            />
                          </Suspense>
                        ) : null
                      ) : (
                        gates.pendingPermissionRequests.map((request) => (
                          <Suspense fallback={null} key={request.requestId}>
                            <PermissionPromptCard
                              requestId={request.requestId}
                              toolName={request.toolName}
                              command={request.command}
                              editTarget={request.editTarget}
                              blockedPath={request.blockedPath}
                              decisionReason={request.decisionReason}
                              busy={gates.resolvingPermissionIds.has(request.requestId)}
                              canAlwaysAllow={request.canAlwaysAllow}
                              alwaysAllowScope={request.alwaysAllowScope}
                              alwaysAllowDescription={request.alwaysAllowDescription}
                              onAllowOnce={(requestId) => void gates.resolvePermission(requestId, "allow")}
                              onAllowAlways={(requestId) => void gates.resolvePermission(requestId, "allow_always")}
                              onDeny={(requestId) => {
                                void gates.resolvePermission(requestId, "deny");
                              }}
                            />
                          </Suspense>
                        ))
                      )}
                    </div>
                  </section>
                ) : null}
                {showQuestionGate ? (
                  <section className="mx-auto w-full max-w-3xl px-3" data-testid="question-prompts-container">
                    <div className="space-y-2">
                      {activeQuestionRequest ? (
                        <Suspense fallback={null} key={activeQuestionRequest.requestId}>
                          <QuestionCard
                            requestId={activeQuestionRequest.requestId}
                            agentLabel={AGENT_LABELS[selectedChatThread?.agent ?? "claude"]}
                            questions={activeQuestionRequest.questions}
                            busy={
                              gates.answeringQuestionIds.has(activeQuestionRequest.requestId)
                              || gates.dismissingQuestionIds.has(activeQuestionRequest.requestId)
                            }
                            position={hasMultiplePendingQuestions ? {
                              current: activeQuestionIndex + 1,
                              total: gates.pendingQuestionRequests.length,
                            } : undefined}
                            onPrevious={handleShowPreviousQuestion}
                            onNext={handleShowNextQuestion}
                            onAnswer={(requestId, answers) => void gates.answerQuestion(requestId, answers)}
                            onDismiss={(requestId) => void gates.dismissQuestion(requestId)}
                          />
                        </Suspense>
                      ) : null}
                    </div>
                  </section>
                ) : null}
                {!gates.showPlanDecisionComposer && gates.isWaitingForUserGate ? <div className="pb-2 pt-1" /> : null}

                {!gates.isWaitingForUserGate ? (
                  <Suspense fallback={<div className="px-3 pb-3 pt-2 text-xs text-muted-foreground">Loading composer...</div>}>
                    <Composer
                      attachedTop={false}
                      disabled={chat.composerDisabled || gates.planActionBusy}
                      focusSignal={focusComposerSignal > 0 ? focusComposerSignal : undefined}
                      sending={chat.sendingMessage}
                      showStop={chat.showStopAction}
                      stopping={chat.stoppingRun}
                      threadId={chat.selectedThreadId}
                      worktreeId={repos.selectedWorktreeId}
                      mode={chat.composerMode}
                      modeLocked={chat.composerModeLocked}
                      slashCommands={slashCommandCatalogWorktreeId ? composerSlashCommands : undefined}
                      slashCommandsLoading={slashCommandCatalogWorktreeId ? composerSlashCommandsLoading : undefined}
                      providers={modelProviders}
                      claudeModels={claudeModels}
                      codexModels={codexModels}
                      cursorModels={cursorModels}
                      opencodeModels={opencodeModels}
                      modelCatalogReadyByAgent={modelCatalogReadyByAgent}
                      runtimeInfo={runtimeInfo.data ?? null}
                      agent={chat.composerAgent}
                      model={chat.composerModel}
                      modelProviderId={chat.composerModelProviderId}
                      modelOptions={chat.composerModelOptions}
                      modelOptionsPerModel={chat.composerModelOptionsPerModel}
                      threadKind={selectedChatThread?.kind ?? null}
                      threadRunning={chat.selectedThreadUiStatus === "running"}
                      permissionMode={chat.composerPermissionMode}
                      sendMessagesWith={generalSettings.sendMessagesWith}
                      autoConvertLongTextEnabled={generalSettings.autoConvertLongTextEnabled}
                      hasMessages={chat.messages.length > 0}
                      queuedMessages={chat.queuedMessages}
                      onSubmitMessage={({ content, mode, attachments }) => chat.submitMessage(content, mode, attachments)}
                      onQueueDraft={({ content, mode, attachments }) => chat.queueDraft(content, mode, attachments)}
                      onModeChange={(mode) => {
                        void chat.setComposerMode(mode);
                      }}
                      onStop={() => void chat.stopAssistantRun()}
                      onAgentSelectionChange={(selection) => {
                        void chat.setComposerAgentSelection(selection);
                      }}
                      onAgentModelSelectorOpen={handleOpenAgentModelSelector}
                      onPermissionModeChange={(permissionMode) => {
                        void chat.setComposerPermissionMode(permissionMode);
                      }}
                      onUpdateQueuedMessage={(queueMessageId, content) => chat.updateQueuedDraft(queueMessageId, content)}
                      onDeleteQueuedMessage={(queueMessageId) => {
                        void chat.deleteQueuedDraft(queueMessageId);
                      }}
                      onDispatchQueuedMessage={(queueMessageId) => {
                        void chat.dispatchQueuedDraft(queueMessageId);
                      }}
                      onCancelQueuedMessageDispatch={(queueMessageId) => {
                        void chat.cancelQueuedDraftDispatch(queueMessageId);
                      }}
                    />
                  </Suspense>
                ) : null}
              </>
            )}
          </div>

          <Suspense fallback={null}>
            <MobileSavePill
              visible={!desktopApp && canSaveActiveFile && activeView !== "file" && !mobileInlinePanel}
              saving={activeEditorFileState?.saving ?? false}
              bottomOffset={mobileKeyboardOffset}
              onSave={() => void handleSaveActiveFile()}
            />
          </Suspense>

          {!desktopApp && activeView !== "automations" && mobileKeyboardOffset === 0 && !mobileUtilitiesFullscreen && !mobileReposDrawerOpen ? (
            <Suspense fallback={null}>
              <MobileActionBar
                hasWorktree={!!repos.selectedWorktreeId}
                gitChangeCount={gitChanges.entries.length}
                activeSection={activeMobileSection}
                onShowChat={handleShowMobileChat}
                onOpenFiles={handleOpenMobileFiles}
                onOpenGit={handleOpenMobileGit}
                onOpenMore={handleOpenMobileMore}
              />
            </Suspense>
          ) : null}

          {/* Mobile must NOT mount BottomPanel: `hidden` (display:none) keeps it
              mounted, so its TerminalTab opens a second terminal WS whose
              container measures 0×0 — fit bails forever and the PTY sits idle at
              80×24. Mobile uses WorkspaceTerminalSurface instead, so only mount
              BottomPanel when the desktop layout is actually active. */}
          {desktopLayout ? (
            <Suspense fallback={null}>
              <BottomPanel
                worktreeId={selectedWorktreeOperational ? repos.selectedWorktreeId : null}
                worktreePath={selectedWorktreeOperational ? (repos.selectedWorktree?.path ?? null) : null}
                scriptOutputs={scriptOutputs}
                activeTab={selectedBottomPanelState.activeTab}
                collapsed={selectedBottomPanelState.collapsed}
                onTabChange={(tab) => updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
                  ...current,
                  activeTab: tab,
                }))}
                onCollapsedChange={(collapsed) => updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
                  ...current,
                  collapsed,
                }))}
                onRerunSetup={handleRerunSetup}
                runScriptActive={selectedBottomPanelState.runScriptActive}
                runScriptSessionId={selectedBottomPanelState.runScriptSessionId}
                onRunScriptExit={(event) => handleRunScriptTerminalExit(event, repos.selectedWorktreeId)}
                onOpenReadFile={(path) => void openReadFile(path)}
                openSignal={selectedBottomPanelState.openSignal}
              />
            </Suspense>
          ) : null}
        </main>

        <Suspense
          fallback={(
            <WorkspaceRightPanelShell
              desktopApp={desktopApp}
              rightPanelId={rightPanelId}
              gitChangeCount={gitChanges.entries.length}
              onUpdatePanel={(panel) => updateSearch({ panel })}
            />
          )}
        >
          <WorkspaceRightPanel
            desktopApp={desktopApp}
            rightPanelId={rightPanelId}
            worktreeId={nonCriticalWorktreeId}
            worktreePending={selectedWorktreePending}
            gitChanges={gitChanges}
            activeFilePath={activeFilePath}
            selectedDiffFilePath={selectedDiffFilePath}
            onOpenReview={handleOpenReview}
            onSelectDiffFile={handleSelectDiffFile}
            onUpdatePanel={(panel) => updateSearch({ panel })}
            onOpenReadFile={openReadFile}
            reviewKind={repositoryReviews.data?.kind ?? null}
            reviewRef={selectedReviewRef}
            prMrActionDisabled={prMrActionDisabled}
            prMrActionTitle={prMrActionTitle}
            prMrActionBusy={prMrActionBusy}
            onPrMrAction={() => void handlePrMrAction()}
          />
        </Suspense>
      </div>
      </div>

      {quickFilePicker.open ? (
        <Suspense fallback={null}>
          <QuickFilePicker
            open={quickFilePicker.open}
            query={quickFilePicker.query}
            items={filteredQuickFileItems}
            loading={fileIndex.loading}
            selectedIndex={quickFilePicker.selectedIndex}
            inputRef={quickFileInputRef}
            shortcutLabel={navigator.platform.toLowerCase().includes("mac") ? "Cmd+Shift+O" : "Ctrl+Shift+O"}
            onQueryChange={handleQuickFileQueryChange}
            onSelectedIndexChange={handleQuickFileSelectedIndexChange}
            onSelect={(item) => {
              void handleQuickFileSelect(item.path);
            }}
            onClose={closeQuickFilePicker}
          />
        </Suspense>
      ) : null}

      {shouldRenderMobileRepositories ? (
        <>
          {/* ── Mobile drawer backdrop ── */}
          <div
            className={cn(
              "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
              mobileReposDrawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            onClick={() => {
              if (mobileReposDrawerOpen) {
                handleCloseMobileRepositories();
              }
            }}
            aria-hidden="true"
          />

          {/* ── Mobile repos drawer (slide from left) ── */}
          <aside
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-[320px] flex-col bg-card shadow-2xl drawer-slide safe-top lg:hidden",
              mobileReposDrawerOpen ? "translate-x-0" : "-translate-x-full",
            )}
            role="dialog"
            aria-modal="true"
            aria-label="Repositories"
          >
            <div className="flex items-center justify-between px-4 pb-2 pt-4">
              <div>
                <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
                <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
              </div>
              <button
                type="button"
                onClick={handleCloseMobileRepositories}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary/60"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-2">
              <Suspense
                fallback={(
                  <WorkspaceSidebarShell
                    desktopApp={true}
                    repositoryName={resolvedStartupRepositoryName}
                    worktreeBranch={resolvedStartupWorktreeBranch}
                    selectedIsRootWorkspace={selectedIsRootWorkspace}
                    isVisible
                  />
                )}
              >
                <MobileRepositoryPanel
                  repositories={orderedRepositories}
                  selectedRepositoryId={repos.selectedRepositoryId}
                  selectedWorktreeId={repos.selectedWorktreeId}
                  selectedWorktreeStatusOverride={selectedWorktreeStatusOverride}
                  worktreeStatusOverrides={worktreeStatusOverrides}
                  enableMetadataQueries={enableNonCriticalWorkspaceData}
                  enableStatusQueries={enableSidebarWorktreeStatuses}
                  threadSnapshot={backgroundStatusThreadSnapshot}
                  hiddenRepositoryIds={hiddenRepositoryIds}
                  expandedByRepo={expandedByRepo}
                  loadingRepos={repos.loadingRepos}
                  submittingRepo={repos.submittingRepo}
                  submittingWorktree={repos.submittingWorktree}
                  onAttachRepository={repos.openFileBrowser}
                  onSelectRepository={handleSelectRepository}
                  onToggleRepositoryExpand={handleToggleRepositoryExpand}
                  onSetRepositoryVisibility={handleSetRepositoryVisibility}
                  onShowAllRepositories={handleShowAllRepositories}
                  onReorderRepositories={handleReorderRepositories}
                  onCreateWorktree={handleCreateWorktree}
                  onSelectWorktree={handleSelectWorktree}
                  onDeleteWorktree={repos.removeWorktree}
                  onRenameWorktreeBranch={repos.renameWorktreeBranch}
                  onPrefetchWorktree={prefetchWorktreeNavigationTarget}
                />
              </Suspense>
            </div>
            <div className="shrink-0 border-t border-border/30 px-4 pt-2 pb-3 safe-bottom">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors active:bg-secondary/60"
                onClick={() => {
                  handleCloseMobileRepositories();
                  openIssueReportDialog();
                }}
              >
                <Bug className="h-3.5 w-3.5" />
                Report Issue
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors active:bg-secondary/60"
                onClick={() => {
                  handleCloseMobileRepositories();
                  openSettingsDialog();
                }}
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </button>
            </div>
          </aside>
        </>
      ) : null}

      {repos.fileBrowserOpen ? (
        <Suspense fallback={null}>
          <FileBrowserModal
            open={repos.fileBrowserOpen}
            onClose={() => repos.setFileBrowserOpen(false)}
            onSelect={(path) => void repos.attachRepositoryFromPath(path)}
            initialPath={repos.selectedRepository?.rootPath ?? repos.repositories[0]?.rootPath ?? null}
          />
        </Suspense>
      ) : null}

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            repositories={repos.repositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            claudeModels={claudeModels}
            codexModels={codexModels}
            cursorModels={cursorModels}
            opencodeModels={opencodeModels}
            modelCatalogsLoading={loadAllModelCatalogs && !allModelCatalogsReady}
            generalSettings={generalSettings}
            runtimeLabel={runtimeLabel}
            runtimeTitle={runtimeTitle}
            onRemoveRepository={(id) => {
              setSettingsOpen(false);
              void repos.removeRepository(id);
            }}
            onGeneralSettingsChange={updateGeneralSettings}
            onOpenIssueReport={openIssueReportDialog}
          />
        </Suspense>
      ) : null}

      {issueReportOpen ? (
        <Suspense fallback={null}>
          <IssueReportDialog
            open={issueReportOpen}
            onClose={() => setIssueReportOpen(false)}
            repositoryId={repos.selectedRepositoryId}
            worktreeId={repos.selectedWorktreeId}
            threadId={chat.selectedThreadId}
          />
        </Suspense>
      ) : null}

      {enableSidebarWorktreeStatuses ? (
        <BackgroundWorktreeStatusStreamBridge
          repositories={backgroundStatusRepositories}
          selectedWorktreeId={repos.selectedWorktreeId}
          selectedThreadId={selectedThreadIdForLiveStatus}
          threadSnapshot={backgroundStatusThreadSnapshot}
          onCompletionAttentionEvent={handleCompletionAttentionEvent}
        />
      ) : null}

      <WorkspaceSyncStreamBridge />
      {visibleLiveError ? (
        <Suspense fallback={null}>
          <LiveStatusErrorToast
            description={visibleLiveError.description}
            title={visibleLiveError.title}
            onDismiss={() => setDismissedLiveErrorSignature(visibleLiveError.signature)}
          />
        </Suspense>
      ) : null}

      <Dialog
        open={confirmCloseThreadId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmCloseThreadId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close session?</DialogTitle>
            <DialogDescription>
              {confirmCloseNeedsStop
                ? (confirmCloseThread
                  ? `AI is still responding in "${confirmCloseThread.title}". Stop the run first before closing this session.`
                  : "AI is still responding in this session. Stop the run first before closing it.")
                : (confirmCloseThread
                  ? `AI is still responding in "${confirmCloseThread.title}". Closing now will end this session.`
                  : "AI is still responding in this session. Closing now will end this session.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmCloseThreadId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmCloseThread()}
              disabled={closingConfirmedThread || chat.stoppingRun}
            >
              {confirmCloseNeedsStop ? "Stop run" : "Close session"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmDeleteThreadId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmDeleteThreadId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              {confirmDeleteThread
                ? `"${confirmDeleteThread.title}" and all of its messages will be permanently deleted. This cannot be undone.`
                : "This session and all of its messages will be permanently deleted. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDeleteThreadId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmDeleteThread()}
              disabled={chat.closingThreadId === confirmDeleteThreadId}
            >
              Delete session
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
