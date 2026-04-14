import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Menu, Settings, X } from "lucide-react";
import type { ReviewKind } from "@codesymphony/shared-types";
import { Composer } from "../components/workspace/composer";
import { ChatMessageList } from "../components/workspace/chat-message-list";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { RepositoryPanel } from "../components/workspace/RepositoryPanel";
import { GitChangesPanel } from "../components/workspace/GitChangesPanel";
import { PermissionPromptCard } from "../components/workspace/PermissionPromptCard";
import { PlanDecisionComposer } from "../components/workspace/PlanDecisionComposer";
import { QuestionCard } from "../components/workspace/QuestionCard";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { FileBrowserModal } from "../components/workspace/FileBrowserModal";
import { SettingsDialog } from "../components/workspace/SettingsDialog";
import { TeardownErrorDialog } from "../components/workspace/TeardownErrorDialog";
import type { ScriptOutputEntry } from "../components/workspace/ScriptOutputTab";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";

const DiffReviewPanel = lazy(() =>
  import("../components/workspace/DiffReviewPanel").then(m => ({ default: m.DiffReviewPanel }))
);
import { api } from "../lib/api";
import { openExternalUrl } from "../lib/openExternalUrl";
import { cn } from "../lib/utils";
import { findRootWorktree, isRootWorktree } from "../lib/worktree";
import { useRepositoryManager } from "./workspace/hooks/useRepositoryManager";
import type { TeardownErrorState, ScriptUpdateEvent } from "./workspace/hooks/useRepositoryManager";
import { useChatSession } from "./workspace/hooks/chat-session";
import { usePendingGates } from "./workspace/hooks/usePendingGates";
import { useGitChanges } from "./workspace/hooks/useGitChanges";
import { useFileIndex } from "./workspace/hooks/useFileIndex";
import { useSlashCommands } from "./workspace/hooks/useSlashCommands";
import { useBackgroundWorktreeStatusStream } from "./workspace/hooks/useBackgroundWorktreeStatusStream";
import { useModelProviders } from "./workspace/hooks/useModelProviders";
import { useWorkspaceSyncStream } from "./workspace/hooks/useWorkspaceSyncStream";
import { useWorkspaceSearchParams } from "./workspace/hooks/useWorkspaceSearchParams";
import { shouldConfirmCloseThread } from "./workspace/closeThreadGuard";
import { useQueryClient } from "@tanstack/react-query";
import { useRepositoryReviews } from "../hooks/queries/useRepositoryReviews";
import { queryKeys } from "../lib/queryKeys";
import { WorkspaceSidebar } from "./workspace/WorkspaceSidebar";
import { WorkspaceRightPanel } from "./workspace/WorkspaceRightPanel";
import { isBaseBranchSelected, resolveReviewBaseBranch, resolveReviewBranch } from "./workspace/reviewBranch";
import {
  appendScriptOutputChunk,
  clearLifecycleScriptOutputs,
  upsertScriptOutputEntry,
} from "./workspace/scriptOutputState";
import {
  loadRepositoryPanelPreferences,
  normalizeRepositoryPanelPreferences,
  reorderRepositoryIds,
  REPOSITORY_PANEL_PREFERENCES_STORAGE_KEY,
  sortRepositoriesByPreference,
  type RepositoryPanelDropPosition,
} from "./workspace/repositoryPanelPreferences";
import { resolveVisibleRepositorySelection } from "./workspace/visibleRepositorySelection";
import {
  resolveChatMessageListKey,
  FilledPlayIcon,
  FilledPauseIcon,
} from "./workspace/workspacePageUtils";

const REPOSITORY_PANEL_EXPANDED_STORAGE_KEY = "codesymphony:workspace:repository-panel-expanded";
const DEFAULT_BOTTOM_PANEL_TAB = "terminal";

type BottomPanelWorktreeState = {
  activeTab: string;
  openSignal: number;
  runScriptActive: boolean;
  collapsed: boolean;
};

function getBottomPanelState(
  state: Record<string, BottomPanelWorktreeState>,
  worktreeId: string | null | undefined,
): BottomPanelWorktreeState {
  if (!worktreeId) {
    return {
      activeTab: DEFAULT_BOTTOM_PANEL_TAB,
      openSignal: 0,
      runScriptActive: false,
      collapsed: true,
    };
  }

  return state[worktreeId] ?? {
    activeTab: DEFAULT_BOTTOM_PANEL_TAB,
    openSignal: 0,
    runScriptActive: false,
    collapsed: true,
  };
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

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function BackgroundWorktreeStatusStreamBridge({
  repositories,
  selectedWorktreeId,
  selectedThreadId,
}: {
  repositories: ReturnType<typeof useRepositoryManager>["repositories"];
  selectedWorktreeId: string | null;
  selectedThreadId: string | null;
}) {
  useBackgroundWorktreeStatusStream(repositories, selectedWorktreeId, selectedThreadId);
  return null;
}

function WorkspaceSyncStreamBridge() {
  useWorkspaceSyncStream();
  return null;
}

export function WorkspacePage() {
  const [error, setError] = useState<string | null>(null);
  const { search, updateSearch } = useWorkspaceSearchParams();

  const prevWorktreeIdRef = useRef<string | undefined>(search.worktreeId);

  const [expandedByRepo, setExpandedByRepo] = useState<Record<string, boolean>>(() => loadRepositoryPanelExpandedState());
  const [repositoryPanelPreferences, setRepositoryPanelPreferences] = useState(() => loadRepositoryPanelPreferences());
  const [scriptOutputs, setScriptOutputs] = useState<ScriptOutputEntry[]>([]);
  const [bottomPanelStateByWorktreeId, setBottomPanelStateByWorktreeId] = useState<Record<string, BottomPanelWorktreeState>>({});
  const [teardownError, setTeardownError] = useState<TeardownErrorState | null>(null);

  const {
    providers: modelProviders,
    refreshProviders: refreshModelProviders,
    replaceProviders: replaceModelProviders,
    selectProvider,
  } = useModelProviders();

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

  const handleSelectProvider = useCallback(async (id: string | null) => {
    try {
      await selectProvider(id);
    } catch {}
  }, [selectProvider]);

  const updateBottomPanelState = useCallback((worktreeId: string | null | undefined, updater: (current: BottomPanelWorktreeState) => BottomPanelWorktreeState) => {
    if (!worktreeId) {
      return;
    }

    setBottomPanelStateByWorktreeId((prev) => ({
      ...prev,
      [worktreeId]: updater(getBottomPanelState(prev, worktreeId)),
    }));
  }, []);

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

  const handleTeardownError = useCallback((state: TeardownErrorState) => {
    setTeardownError(state);
  }, []);

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
    desiredRepoId: search.repoId,
    desiredWorktreeId: search.worktreeId,
    onScriptUpdate: handleScriptUpdate,
    onScriptOutputChunk: handleScriptOutputChunk,
    onTeardownError: handleTeardownError,
    onSelectionChange: useCallback(
      (selection: { repoId: string | null; worktreeId: string | null }) => {
        const worktreeChanged = (selection.worktreeId ?? undefined) !== prevWorktreeIdRef.current;
        prevWorktreeIdRef.current = selection.worktreeId ?? undefined;
        updateSearch({
          repoId: selection.repoId ?? undefined,
          worktreeId: selection.worktreeId ?? undefined,
          ...(worktreeChanged ? { threadId: undefined } : {}),
        });
      },
      [updateSearch],
    ),
  });
  const repositoriesLoadError = repos.repositoriesError instanceof Error
    ? repos.repositoriesError.message
    : null;
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
  const visibleRepositories = useMemo(
    () => orderedRepositories.filter((repository) => !hiddenRepositoryIdSet.has(repository.id)),
    [hiddenRepositoryIdSet, orderedRepositories],
  );

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
    const nextSelection = resolveVisibleRepositorySelection({
      visibleRepositories,
      selectedRepositoryId: repos.selectedRepositoryId,
    });

    if (!nextSelection) {
      return;
    }

    repos.setSelectedRepositoryId(nextSelection.repositoryId);
    repos.setSelectedWorktreeId(nextSelection.worktreeId);
  }, [
    repos.selectedRepositoryId,
    repos.setSelectedRepositoryId,
    repos.setSelectedWorktreeId,
    visibleRepositories,
  ]);

  const handleSelectRepository = useCallback((repositoryId: string) => {
    repos.setSelectedRepositoryId(repositoryId);
    const repository = repos.repositories.find((entry) => entry.id === repositoryId);
    if (!repository) {
      repos.setSelectedWorktreeId(null);
      return;
    }

    const primaryWorktree = findRootWorktree(repository);
    repos.setSelectedWorktreeId(primaryWorktree?.id ?? null);
  }, [repos.repositories, repos.setSelectedRepositoryId, repos.setSelectedWorktreeId]);

  const handleSelectWorktree = useCallback((repositoryId: string, worktreeId: string, preferredThreadId?: string | null) => {
    repos.setSelectedRepositoryId(repositoryId);
    repos.setSelectedWorktreeId(worktreeId);
    updateSearch({
      repoId: repositoryId,
      worktreeId,
      threadId: preferredThreadId ?? undefined,
      view: undefined,
      file: undefined,
    });
  }, [repos.setSelectedRepositoryId, repos.setSelectedWorktreeId, updateSearch]);

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
  const selectedContextLabel = repos.selectedWorktree
    ? (selectedIsRootWorkspace
      ? "Root Workspace"
      : `Worktree ${repos.selectedWorktree.branch} from ${repos.selectedWorktree.baseBranch}`)
    : "Choose a workspace";

  const activeView = search.view ?? "chat";
  const selectedDiffFilePath = search.file ?? null;
  const reviewTabOpen = activeView === "review";
  const queryClient = useQueryClient();
  const gitChanges = useGitChanges(repos.selectedWorktreeId, !!repos.selectedWorktreeId);
  const repositoryReviews = useRepositoryReviews(repos.selectedRepositoryId);
  const selectedReviewBranch = resolveReviewBranch(gitChanges.branch, repos.selectedWorktree?.branch ?? null);
  const selectedReviewBaseBranch = resolveReviewBaseBranch(
    repos.selectedWorktree?.baseBranch ?? null,
    repos.selectedRepository?.defaultBranch ?? null,
  );
  const selectedWorktreeIsBaseBranch = isBaseBranchSelected(selectedReviewBranch, selectedReviewBaseBranch);
  const selectedLatestReviewRef = repos.selectedWorktree && repositoryReviews.data
    ? repositoryReviews.data.reviewsByBranch[selectedReviewBranch ?? repos.selectedWorktree.branch] ?? null
    : null;
  const selectedReviewRef = selectedLatestReviewRef?.state === "open" ? selectedLatestReviewRef : null;
  const reviewKind: ReviewKind = repositoryReviews.data?.kind ?? "pr";

  const chat = useChatSession(repos.selectedWorktreeId, setError, repos.updateWorktreeBranch, {
    desiredThreadId: search.threadId,
    repositoryId: repos.selectedRepositoryId,
    timelineEnabled: !reviewTabOpen,
    onThreadChange: useCallback(
      (threadId: string | null) => {
        updateSearch({ threadId: threadId ?? undefined });
      },
      [updateSearch],
    ),
  });
  const prMrThread = chat.threads.find((thread) => thread.kind === "review") ?? null;
  const prMrThreadIsActiveOrPending = !!prMrThread && (
    prMrThread.active
    || prMrThread.id === chat.waitingAssistant?.threadId
    || (chat.sendingMessage && prMrThread.id === chat.selectedThreadId)
  );
  const prevSelectedThreadIdRef = useRef<string | null>(chat.selectedThreadId);
  const chatMessageListKeyRef = useRef<string>(chat.selectedThreadId ?? "empty");
  const chatMessageListKey = resolveChatMessageListKey({
    previousKey: chatMessageListKeyRef.current,
    previousThreadId: prevSelectedThreadIdRef.current,
    nextThreadId: chat.selectedThreadId,
  });

  if (chatMessageListKey !== chatMessageListKeyRef.current) {
    chatMessageListKeyRef.current = chatMessageListKey;
  }

  useEffect(() => {
    prevSelectedThreadIdRef.current = chat.selectedThreadId;
  }, [chat.selectedThreadId]);

  const gates = usePendingGates(chat.events, chat.selectedThreadId, {
    onError: setError,
    startWaitingAssistant: chat.startWaitingAssistant,
    clearWaitingAssistantForThread: chat.clearWaitingAssistantForThread,
  });
  const [activePermissionRequestId, setActivePermissionRequestId] = useState<string | null>(null);

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
  const rightPanelId = search.panel ?? null;
  const [mobilePanelOpen, setMobilePanelOpen] = useState<"repos" | "git" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmCloseThreadId, setConfirmCloseThreadId] = useState<string | null>(null);

  const fileIndex = useFileIndex(repos.selectedWorktreeId);
  const slashCommands = useSlashCommands(repos.selectedWorktreeId);

  // Close mobile drawer on Escape key
  useEffect(() => {
    if (!mobilePanelOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobilePanelOpen(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobilePanelOpen]);

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

  const waitingAssistantThreadId = chat.waitingAssistant?.threadId ?? null;

  const showThinkingPlaceholder =
    chat.selectedThreadUiStatus === "running" && !gates.isWaitingForUserGate;

  const openReadFile = useCallback(
    async (filePath: string) => {
      if (!repos.selectedWorktreeId) {
        setError("Worktree is not selected");
        return;
      }
      try {
        await api.openWorktreeFile(repos.selectedWorktreeId, { path: filePath });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to open file");
      }
    },
    [repos.selectedWorktreeId],
  );

  const handleOpenReview = useCallback(() => {
    updateSearch({ file: undefined, view: "review" });
  }, [updateSearch]);

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

  const reviewLookupAvailable = !!repositoryReviews.data?.available;
  const prMrActionBusy = !selectedReviewRef && prMrThreadIsActiveOrPending;
  const prMrActionDisabled = (
    !repos.selectedWorktree
    || selectedWorktreeIsBaseBranch
    || (!selectedReviewRef && !reviewLookupAvailable)
    || (!selectedReviewRef && prMrThreadIsActiveOrPending)
  );
  const prMrActionTitle = selectedWorktreeIsBaseBranch
    ? "Cannot start a PR/MR thread from the base branch"
    : (!selectedReviewRef && prMrThreadIsActiveOrPending)
      ? "PR/MR thread is already active"
      : repositoryReviews.data?.unavailableReason;

  const forceDeleteQueryClient = queryClient;

  const handleForceDelete = useCallback(async (worktreeId: string) => {
    try {
      await api.deleteWorktree(worktreeId, { force: true });
      setTeardownError(null);
      if (repos.selectedWorktreeId === worktreeId) {
        repos.setSelectedWorktreeId(null);
      }
      void forceDeleteQueryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Force delete failed");
      setTeardownError(null);
    }
  }, [repos.selectedWorktreeId, repos.setSelectedWorktreeId, forceDeleteQueryClient]);

  const handleRerunSetup = useCallback(() => {
    const worktreeId = repos.selectedWorktreeId;
    if (!worktreeId) return;
    setScriptOutputs((prev) => clearLifecycleScriptOutputs(prev, worktreeId));
    updateBottomPanelState(worktreeId, (current) => ({
      ...current,
      activeTab: "setup-script",
      openSignal: current.openSignal + 1,
    }));
    void repos.rerunSetup(worktreeId);
  }, [repos.rerunSetup, repos.selectedWorktreeId, updateBottomPanelState]);

  const resolveRunScriptSessionId = useCallback(() => {
    if (!repos.selectedWorktreeId) return null;
    return `${repos.selectedWorktreeId}:script-runner`;
  }, [repos.selectedWorktreeId]);

  const handleRunScript = useCallback(async () => {
    if (!repos.selectedWorktreeId || !repos.selectedWorktree) return;
    const runCommands = (repos.selectedRepository?.runScript ?? [])
      .map((command) => command.trim())
      .filter((command) => command.length > 0);
    if (runCommands.length === 0) {
      setSettingsOpen(true);
      return;
    }
    const shellScript = runCommands.join(" ; ");
    const sessionId = resolveRunScriptSessionId();
    if (!sessionId) return;

    try {
      updateBottomPanelState(repos.selectedWorktreeId, (current) => ({
        ...current,
        activeTab: "run",
        openSignal: current.openSignal + 1,
        runScriptActive: true,
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
  }, [repos.selectedWorktreeId, repos.selectedWorktree, repos.selectedRepository, resolveRunScriptSessionId, updateBottomPanelState]);

  const handleStopRunScript = useCallback(async () => {
    const sessionId = resolveRunScriptSessionId();
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
  }, [repos.selectedWorktreeId, resolveRunScriptSessionId, updateBottomPanelState]);

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

  const handleSelectDiffFile = useCallback((filePath: string) => {
    updateSearch({ file: filePath, view: "review" });
  }, [updateSearch]);

  const handleCloseReview = useCallback(() => {
    updateSearch({ view: undefined, file: undefined });
  }, [updateSearch]);

  const handleSelectThread = useCallback(
    (threadId: string | null) => {
      chat.setSelectedThreadId(threadId);
      updateSearch({ view: undefined, threadId: threadId ?? undefined });
    },
    [chat.setSelectedThreadId, updateSearch],
  );

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
  const closingConfirmedThread =
    confirmCloseThreadId !== null && chat.closingThreadId === confirmCloseThreadId;
  const confirmCloseNeedsStop =
    confirmCloseThreadId !== null && (
      waitingAssistantThreadId === confirmCloseThreadId
      || chat.threads.some((thread) => thread.id === confirmCloseThreadId && thread.active)
    );

  return (
    <div className="flex h-full p-1 pb-0 safe-top sm:p-2 sm:pb-0 lg:p-0">
      <div className="flex min-h-0 w-full">
        <WorkspaceSidebar
          repos={repos}
          orderedRepositories={orderedRepositories}
          hiddenRepositoryIds={hiddenRepositoryIds}
          expandedByRepo={expandedByRepo}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectRepository={handleSelectRepository}
          onToggleRepositoryExpand={handleToggleRepositoryExpand}
          onSetRepositoryVisibility={handleSetRepositoryVisibility}
          onShowAllRepositories={handleShowAllRepositories}
          onReorderRepositories={handleReorderRepositories}
          onSelectWorktree={handleSelectWorktree}
        />

        {/* ── Main content area (chat + bottom panel) ── */}
        <main className="workspace-main flex min-h-0 min-w-0 flex-1 flex-col p-1.5 pb-0 sm:p-2.5 sm:pb-0 lg:p-3 lg:pb-0">
          {/* ── Mobile top bar ── */}
          <div className="flex items-center gap-2 pb-1.5 lg:hidden">
            <button
              type="button"
              onClick={() => setMobilePanelOpen("repos")}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground transition-colors active:bg-secondary"
              aria-label="Open repositories"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[13px] font-semibold tracking-wide">CodeSymphony</h1>
              <p className="truncate text-[10px] text-muted-foreground">
                {repos.selectedRepository?.name ?? "No repository"}
                {repos.selectedWorktree
                  ? ` · ${selectedIsRootWorkspace ? "Root Workspace" : repos.selectedWorktree.branch}`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleRunScript}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground transition-colors active:bg-secondary"
              aria-label={selectedBottomPanelState.runScriptActive ? "Stop script" : "Run script"}
            >
              {selectedBottomPanelState.runScriptActive ? (
                <FilledPauseIcon className="h-4 w-4" />
              ) : (
                <FilledPlayIcon className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setMobilePanelOpen("git")}
              className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground transition-colors active:bg-secondary"
              aria-label="Open source control"
            >
              <GitBranch className="h-4 w-4" />
              {gitChanges.entries.length > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
                  {gitChanges.entries.length > 99 ? "99+" : gitChanges.entries.length}
                </span>
              )}
            </button>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 lg:gap-2">
            <WorkspaceHeader
              selectedRepositoryName={repos.selectedRepository?.name ?? "No repository selected"}
              selectedWorktreeLabel={selectedContextLabel}
              worktreePath={repos.selectedWorktree?.path ?? null}
              threads={chat.threads}
              selectedThreadId={chat.selectedThreadId}
              disabled={!repos.selectedWorktreeId}
              createThreadDisabled={!repos.selectedWorktreeId || chat.sendingMessage}
              closingThreadId={chat.closingThreadId}
              protectedThreadId={chat.showStopAction ? chat.selectedThreadId : null}
              showReviewTab={reviewTabOpen}
              reviewTabActive={activeView === "review"}
              onSelectThread={handleSelectThread}
              onCreateThread={() => void chat.createAdditionalThread()}
              onCloseThread={handleRequestCloseThread}
              onRenameThread={(threadId, title) => chat.renameThreadTitle(threadId, title)}
              onSelectReviewTab={() => updateSearch({ view: "review" })}
              onCloseReviewTab={handleCloseReview}
              runScriptRunning={selectedBottomPanelState.runScriptActive}
              onToggleRunScript={handleToggleRunScript}
            />

            {uiError ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                <strong>!</strong> {uiError}
              </div>
            ) : null}

            {activeView === "review" && reviewTabOpen && repos.selectedWorktreeId ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading review...</div>}>
                  <DiffReviewPanel worktreeId={repos.selectedWorktreeId} selectedFilePath={selectedDiffFilePath} />
                </Suspense>
              </section>
            ) : (
              <>
                <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="min-h-0 min-w-0 flex-1">
                    <ChatMessageList
                      key={chatMessageListKey}
                      items={chat.timelineItems}
                      emptyState={chat.messageListEmptyState}
                      showThinkingPlaceholder={showThinkingPlaceholder}
                      onOpenReadFile={openReadFile}
                    />
                  </div>
                </section>
                {gates.pendingPermissionRequests.length > 0 ? (
                  <section className="mx-auto w-full max-w-3xl px-3" data-testid="permission-prompts-container">
                    <div className="space-y-2">
                      {hasMultiplePendingPermissions ? (
                        activePermissionRequest ? (
                          <PermissionPromptCard
                            key={activePermissionRequest.requestId}
                            requestId={activePermissionRequest.requestId}
                            toolName={activePermissionRequest.toolName}
                            command={activePermissionRequest.command}
                            editTarget={activePermissionRequest.editTarget}
                            blockedPath={activePermissionRequest.blockedPath}
                            decisionReason={activePermissionRequest.decisionReason}
                            busy={gates.resolvingPermissionIds.has(activePermissionRequest.requestId)}
                            canAlwaysAllow={Boolean(activePermissionRequest.command)}
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
                        ) : null
                      ) : (
                        gates.pendingPermissionRequests.map((request) => (
                          <PermissionPromptCard
                            key={request.requestId}
                            requestId={request.requestId}
                            toolName={request.toolName}
                            command={request.command}
                            editTarget={request.editTarget}
                            blockedPath={request.blockedPath}
                            decisionReason={request.decisionReason}
                            busy={gates.resolvingPermissionIds.has(request.requestId)}
                            canAlwaysAllow={Boolean(request.command)}
                            onAllowOnce={(requestId) => void gates.resolvePermission(requestId, "allow")}
                            onAllowAlways={(requestId) => void gates.resolvePermission(requestId, "allow_always")}
                            onDeny={(requestId) => {
                              void gates.resolvePermission(requestId, "deny");
                            }}
                          />
                        ))
                      )}
                    </div>
                  </section>
                ) : null}
                {gates.pendingQuestionRequests.length > 0 ? (
                  <section className="mx-auto w-full max-w-3xl px-3" data-testid="question-prompts-container">
                    <div className="space-y-2">
                      {gates.pendingQuestionRequests.map((request) => (
                        <QuestionCard
                          key={request.requestId}
                          requestId={request.requestId}
                          questions={request.questions}
                          busy={gates.answeringQuestionIds.has(request.requestId) || gates.dismissingQuestionIds.has(request.requestId)}
                          onAnswer={(requestId, answers) => void gates.answerQuestion(requestId, answers)}
                          onDismiss={(requestId) => void gates.dismissQuestion(requestId)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
                {!gates.showPlanDecisionComposer && gates.isWaitingForUserGate ? <div className="pb-2 pt-1" /> : null}

                {gates.showPlanDecisionComposer ? (
                  <PlanDecisionComposer
                    busy={gates.planActionBusy}
                    onApprove={() => void gates.handleApprovePlan()}
                    onRevise={(feedback) => void gates.handleRevisePlan(feedback)}
                    onDismiss={() => gates.handleDismissPlan()}
                  />
                ) : !gates.isWaitingForUserGate ? (
                  <Composer
                    disabled={chat.composerDisabled || gates.planActionBusy}
                    sending={chat.sendingMessage}
                    showStop={chat.showStopAction}
                    stopping={chat.stoppingRun}
                    threadId={chat.selectedThreadId}
                    worktreeId={repos.selectedWorktreeId}
                    mode={chat.composerMode}
                    modeLocked={chat.composerModeLocked}
                    fileIndex={fileIndex.entries}
                    fileIndexLoading={fileIndex.loading}
                    slashCommands={slashCommands.commands}
                    slashCommandsLoading={slashCommands.loading}
                    providers={modelProviders}
                    permissionMode={chat.composerPermissionMode}
                    hasMessages={chat.messages.length > 0}
                    onSubmitMessage={({ content, mode, attachments }) => chat.submitMessage(content, mode, attachments)}
                    onModeChange={(mode) => {
                      if (chat.selectedThreadId) {
                        void chat.setThreadMode(chat.selectedThreadId, mode);
                      }
                    }}
                    onStop={() => void chat.stopAssistantRun()}
                    onSelectProvider={(id) => void handleSelectProvider(id)}
                    onPermissionModeChange={(permissionMode) => {
                      void chat.setComposerPermissionMode(permissionMode);
                    }}
                  />
                ) : null}
              </>
            )}
          </div>

          <BottomPanel
            worktreeId={repos.selectedWorktreeId}
            worktreePath={repos.selectedWorktree?.path ?? null}
            selectedThreadId={chat.selectedThreadId}
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
            onRunScriptExit={(event) => handleRunScriptTerminalExit(event, repos.selectedWorktreeId)}
            openSignal={selectedBottomPanelState.openSignal}
          />
        </main>

        <WorkspaceRightPanel
          rightPanelId={rightPanelId}
          gitChanges={gitChanges}
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
      </div>

      {/* ── Mobile drawer backdrop ── */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
          mobilePanelOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setMobilePanelOpen(null)}
        aria-hidden="true"
      />

      {/* ── Mobile repos drawer (slide from left) ── */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-[320px] flex-col bg-card shadow-2xl drawer-slide safe-top lg:hidden",
          mobilePanelOpen === "repos" ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <div>
            <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
            <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
          </div>
          <button
            type="button"
            onClick={() => setMobilePanelOpen(null)}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary/60"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-2">
          <RepositoryPanel
            repositories={orderedRepositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            selectedWorktreeId={repos.selectedWorktreeId}
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
            onCreateWorktree={(repositoryId) => void repos.submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId, preferredThreadId) => {
              handleSelectWorktree(repositoryId, worktreeId, preferredThreadId);
              setMobilePanelOpen(null);
            }}
            onDeleteWorktree={(worktreeId) => void repos.removeWorktree(worktreeId)}
            onRenameWorktreeBranch={(worktreeId, newBranch) => void repos.renameWorktreeBranch(worktreeId, newBranch)}
          />
        </div>
        <div className="shrink-0 border-t border-border/30 px-4 pt-2 pb-3 safe-bottom">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors active:bg-secondary/60"
            onClick={() => {
              setMobilePanelOpen(null);
              setSettingsOpen(true);
            }}
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      </aside>

      {/* ── Mobile git drawer (slide from right) ── */}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-[360px] flex-col bg-card shadow-2xl drawer-slide safe-top safe-bottom lg:hidden",
          mobilePanelOpen === "git" ? "translate-x-0" : "translate-x-full",
        )}
      >
        {mobilePanelOpen === "git" && (
          <GitChangesPanel
            entries={gitChanges.entries}
            branch={gitChanges.branch}
            loading={gitChanges.loading}
            committing={gitChanges.committing}
            error={gitChanges.error}
            selectedFilePath={selectedDiffFilePath}
            onCommit={(msg) => void gitChanges.commit(msg)}
            onReview={() => {
              handleOpenReview();
              setMobilePanelOpen(null);
            }}
            onRefresh={() => void gitChanges.refresh()}
            onClose={() => setMobilePanelOpen(null)}
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
        )}
      </aside>

      <FileBrowserModal
        open={repos.fileBrowserOpen}
        onClose={() => repos.setFileBrowserOpen(false)}
        onSelect={(path) => void repos.attachRepositoryFromPath(path)}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        repositories={repos.repositories}
        onRemoveRepository={(id) => {
          setSettingsOpen(false);
          void repos.removeRepository(id);
        }}
        onProvidersChanged={replaceModelProviders}
      />

      <TeardownErrorDialog
        open={teardownError !== null}
        worktreeId={teardownError?.worktreeId ?? null}
        worktreeName={teardownError?.worktreeName ?? ""}
        output={teardownError?.output ?? ""}
        onForceDelete={(id) => void handleForceDelete(id)}
        onClose={() => setTeardownError(null)}
      />

      <BackgroundWorktreeStatusStreamBridge
        repositories={repos.repositories}
        selectedWorktreeId={repos.selectedWorktreeId}
        selectedThreadId={chat.selectedThreadIdForData ?? chat.selectedThreadId}
      />

      <WorkspaceSyncStreamBridge />

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
    </div>
  );
}
