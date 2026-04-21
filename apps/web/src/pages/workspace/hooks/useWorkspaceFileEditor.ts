import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceFileTab } from "../../../components/workspace/WorkspaceHeader";
import { buildQuickFileItems, filterQuickFileItems } from "../../../components/workspace/quickFilePickerUtils";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { parseFileLocation, resolveWorktreeRelativePath } from "../../../lib/worktree";
import type { WorkspaceSearch } from "../../../routes/index";

type EditorFileState = {
  savedContent: string;
  draftContent: string;
  mimeType: string;
  loading: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
};

type EditorGitBaselineState = {
  headContent: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  versionKey: string;
};

type OpenFileTab = {
  path: string;
  pinned: boolean;
};

type QuickFilePickerState = {
  open: boolean;
  query: string;
  selectedIndex: number;
};

function createInitialEditorFileState(): EditorFileState {
  return {
    savedContent: "",
    draftContent: "",
    mimeType: "text/plain",
    loading: false,
    loaded: false,
    saving: false,
    error: null,
  };
}

function createInitialEditorGitBaselineState(): EditorGitBaselineState {
  return {
    headContent: null,
    loading: false,
    loaded: false,
    error: null,
    versionKey: "",
  };
}

interface UseWorkspaceFileEditorOptions {
  activeFilePath: string | null;
  activeGitBaselineVersionKey: string;
  activeView: WorkspaceSearch["view"] | undefined;
  fileEntries: FileEntry[];
  onError: (message: string | null) => void;
  onOpenQuickFilePicker?: () => void;
  selectedThreadId: string | null;
  selectedWorktreeId: string | null;
  selectedWorktreePath: string | null;
  updateSearch: (partial: Partial<WorkspaceSearch>) => void;
}

export function useWorkspaceFileEditor({
  activeFilePath,
  activeGitBaselineVersionKey,
  activeView,
  fileEntries,
  onError,
  onOpenQuickFilePicker,
  selectedThreadId,
  selectedWorktreeId,
  selectedWorktreePath,
  updateSearch,
}: UseWorkspaceFileEditorOptions) {
  const queryClient = useQueryClient();
  const [openFileTabsByWorktreeId, setOpenFileTabsByWorktreeId] = useState<Record<string, OpenFileTab[]>>({});
  const [recentFilePathsByWorktreeId, setRecentFilePathsByWorktreeId] = useState<Record<string, string[]>>({});
  const [editorFileStateByWorktreeId, setEditorFileStateByWorktreeId] = useState<Record<string, Record<string, EditorFileState>>>({});
  const [editorGitBaselineStateByWorktreeId, setEditorGitBaselineStateByWorktreeId] = useState<Record<string, Record<string, EditorGitBaselineState>>>({});
  const quickFileInputRef = useRef<HTMLInputElement | null>(null);
  const [quickFilePicker, setQuickFilePicker] = useState<QuickFilePickerState>({
    open: false,
    query: "",
    selectedIndex: 0,
  });
  const editorFileStateRef = useRef(editorFileStateByWorktreeId);
  const editorGitBaselineStateRef = useRef(editorGitBaselineStateByWorktreeId);
  const closingActiveFileRef = useRef<{ worktreeId: string; filePath: string } | null>(null);

  const quickFileItems = useMemo(
    () => buildQuickFileItems(fileEntries),
    [fileEntries],
  );
  const filteredQuickFileItems = useMemo(
    () => filterQuickFileItems(quickFileItems, quickFilePicker.query),
    [quickFileItems, quickFilePicker.query],
  );

  const activeWorktreeFileTabs = useMemo(
    () => (selectedWorktreeId ? openFileTabsByWorktreeId[selectedWorktreeId] ?? [] : []),
    [openFileTabsByWorktreeId, selectedWorktreeId],
  );
  const activeWorktreeEditorStates = selectedWorktreeId
    ? editorFileStateByWorktreeId[selectedWorktreeId] ?? {}
    : {};
  const activeWorktreeGitBaselines = selectedWorktreeId
    ? editorGitBaselineStateByWorktreeId[selectedWorktreeId] ?? {}
    : {};
  const workspaceFileTabs = useMemo<WorkspaceFileTab[]>(
    () => activeWorktreeFileTabs.map((tab) => {
      const state = activeWorktreeEditorStates[tab.path] ?? createInitialEditorFileState();
      return {
        path: tab.path,
        dirty: state.loaded && state.draftContent !== state.savedContent,
        pinned: tab.pinned,
      };
    }),
    [activeWorktreeEditorStates, activeWorktreeFileTabs],
  );
  const activeEditorFileState = useMemo(() => {
    if (!activeFilePath) {
      return null;
    }

    const existingState = activeWorktreeEditorStates[activeFilePath];
    if (existingState) {
      return existingState;
    }

    if (selectedWorktreeId && activeView === "file") {
      return {
        ...createInitialEditorFileState(),
        loading: true,
      };
    }

    return null;
  }, [activeFilePath, activeView, activeWorktreeEditorStates, selectedWorktreeId]);
  const activeEditorGitBaselineState = activeFilePath ? activeWorktreeGitBaselines[activeFilePath] ?? null : null;
  const recentFilePaths = selectedWorktreeId ? recentFilePathsByWorktreeId[selectedWorktreeId] ?? [] : [];
  const activeFileDirty = !!(
    activeEditorFileState
    && activeEditorFileState.loaded
    && !activeEditorFileState.mimeType.startsWith("image/")
    && activeEditorFileState.draftContent !== activeEditorFileState.savedContent
  );
  const canSaveActiveFile = !!(
    activeEditorFileState
    && activeFileDirty
    && !activeEditorFileState.loading
    && !activeEditorFileState.saving
    && !activeEditorFileState.error
  );

  useEffect(() => {
    editorFileStateRef.current = editorFileStateByWorktreeId;
  }, [editorFileStateByWorktreeId]);

  useEffect(() => {
    editorGitBaselineStateRef.current = editorGitBaselineStateByWorktreeId;
  }, [editorGitBaselineStateByWorktreeId]);

  const updateEditorFileState = useCallback((
    worktreeId: string,
    filePath: string,
    updater: (current: EditorFileState) => EditorFileState,
  ) => {
    setEditorFileStateByWorktreeId((current) => {
      const worktreeState = current[worktreeId] ?? {};
      return {
        ...current,
        [worktreeId]: {
          ...worktreeState,
          [filePath]: updater(worktreeState[filePath] ?? createInitialEditorFileState()),
        },
      };
    });
  }, []);

  const updateEditorGitBaselineState = useCallback((
    worktreeId: string,
    filePath: string,
    updater: (current: EditorGitBaselineState) => EditorGitBaselineState,
  ) => {
    setEditorGitBaselineStateByWorktreeId((current) => {
      const worktreeState = current[worktreeId] ?? {};
      return {
        ...current,
        [worktreeId]: {
          ...worktreeState,
          [filePath]: updater(worktreeState[filePath] ?? createInitialEditorGitBaselineState()),
        },
      };
    });
  }, []);

  const closeFileTabState = useCallback((worktreeId: string, filePath: string) => {
    setOpenFileTabsByWorktreeId((current) => {
      const existingTabs = current[worktreeId] ?? [];
      if (!existingTabs.some((tab) => tab.path === filePath)) {
        return current;
      }
      return {
        ...current,
        [worktreeId]: existingTabs.filter((tab) => tab.path !== filePath),
      };
    });
  }, []);

  const getEditorFileState = useCallback((worktreeId: string, filePath: string) => {
    return editorFileStateByWorktreeId[worktreeId]?.[filePath] ?? createInitialEditorFileState();
  }, [editorFileStateByWorktreeId]);

  const pushRecentFile = useCallback((worktreeId: string, filePath: string) => {
    setRecentFilePathsByWorktreeId((current) => {
      const nextPaths = [filePath, ...(current[worktreeId] ?? []).filter((path) => path !== filePath)].slice(0, 16);
      if ((current[worktreeId] ?? []).every((path, index) => path === nextPaths[index]) && (current[worktreeId] ?? []).length === nextPaths.length) {
        return current;
      }

      return {
        ...current,
        [worktreeId]: nextPaths,
      };
    });
  }, []);

  useEffect(() => {
    if (!selectedWorktreeId || !activeFilePath) {
      return;
    }

    pushRecentFile(selectedWorktreeId, activeFilePath);
  }, [activeFilePath, pushRecentFile, selectedWorktreeId]);

  const isFileDirty = useCallback((worktreeId: string, filePath: string) => {
    const state = getEditorFileState(worktreeId, filePath);
    return state.loaded && state.draftContent !== state.savedContent;
  }, [getEditorFileState]);

  const canDiscardDirtyWorktreeFiles = useCallback((worktreeId: string | null) => {
    if (!worktreeId) {
      return true;
    }

    const fileStates = editorFileStateByWorktreeId[worktreeId] ?? {};
    const dirtyCount = Object.values(fileStates).filter((state) => state.loaded && state.draftContent !== state.savedContent).length;
    if (dirtyCount === 0) {
      return true;
    }

    const message = dirtyCount === 1
      ? "Switch worktrees with an unsaved file open?"
      : `Switch worktrees with ${dirtyCount} unsaved files open?`;
    return window.confirm(message);
  }, [editorFileStateByWorktreeId]);

  const confirmDiscardDirtyFile = useCallback((worktreeId: string, filePath: string) => {
    if (!isFileDirty(worktreeId, filePath)) {
      return true;
    }

    const filename = filePath.split("/").pop() ?? filePath;
    return window.confirm(`Close ${filename} without saving its changes?`);
  }, [isFileDirty]);

  const ensureFileTab = useCallback((worktreeId: string, filePath: string, options?: { pin?: boolean }) => {
    const shouldPin = options?.pin ?? false;
    const existingTabs = openFileTabsByWorktreeId[worktreeId] ?? [];
    const existingTab = existingTabs.find((tab) => tab.path === filePath) ?? null;
    const previewTab = existingTabs.find((tab) => !tab.pinned) ?? null;

    if (existingTab) {
      if (!shouldPin || existingTab.pinned) {
        return { ok: true as const };
      }

      setOpenFileTabsByWorktreeId((current) => ({
        ...current,
        [worktreeId]: (current[worktreeId] ?? []).map((tab) =>
          tab.path === filePath ? { ...tab, pinned: true } : tab
        ),
      }));
      return { ok: true as const };
    }

    if (!shouldPin && previewTab && previewTab.path !== filePath) {
      if (!confirmDiscardDirtyFile(worktreeId, previewTab.path)) {
        return { ok: false as const };
      }

      setOpenFileTabsByWorktreeId((current) => ({
        ...current,
        [worktreeId]: (current[worktreeId] ?? []).map((tab) =>
          tab.path === previewTab.path ? { path: filePath, pinned: false } : tab
        ),
      }));
      setEditorFileStateByWorktreeId((current) => {
        const worktreeState = current[worktreeId] ?? {};
        if (!(previewTab.path in worktreeState)) {
          return current;
        }

        const { [previewTab.path]: _removed, ...rest } = worktreeState;
        return {
          ...current,
          [worktreeId]: rest,
        };
      });
      setEditorGitBaselineStateByWorktreeId((current) => {
        const worktreeState = current[worktreeId] ?? {};
        if (!(previewTab.path in worktreeState)) {
          return current;
        }

        const { [previewTab.path]: _removed, ...rest } = worktreeState;
        return {
          ...current,
          [worktreeId]: rest,
        };
      });
      return { ok: true as const };
    }

    setOpenFileTabsByWorktreeId((current) => ({
      ...current,
      [worktreeId]: [...(current[worktreeId] ?? []), { path: filePath, pinned: shouldPin }],
    }));
    return { ok: true as const };
  }, [confirmDiscardDirtyFile, openFileTabsByWorktreeId]);

  const confirmSwitchAwayFromActiveFile = useCallback(() => {
    if (!selectedWorktreeId || !activeFilePath) {
      return true;
    }

    if (!isFileDirty(selectedWorktreeId, activeFilePath)) {
      return true;
    }

    const filename = activeFilePath.split("/").pop() ?? activeFilePath;
    return window.confirm(`Switch away from ${filename} without saving yet?`);
  }, [activeFilePath, isFileDirty, selectedWorktreeId]);

  const normalizeOpenFileTarget = useCallback((filePath: string) => {
    const location = parseFileLocation(filePath);
    const relativePath = selectedWorktreePath
      ? resolveWorktreeRelativePath(
        selectedWorktreePath,
        location.path,
        fileEntries.map((entry) => entry.path),
      )
      : null;

    return {
      path: relativePath && relativePath.length > 0 ? relativePath : location.path,
      line: location.line,
      column: location.column,
    };
  }, [fileEntries, selectedWorktreePath]);

  const loadEditorFile = useCallback((worktreeId: string, filePath: string) => {
    const currentFileState = editorFileStateRef.current[worktreeId]?.[filePath] ?? createInitialEditorFileState();
    if (currentFileState.loading || currentFileState.loaded) {
      return () => {};
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort(new DOMException("File load timed out", "AbortError"));
    }, 15_000);

    let cancelled = false;

    updateEditorFileState(worktreeId, filePath, (current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    void api.getWorktreeFileContent(worktreeId, filePath, controller.signal)
      .then((result) => {
        if (cancelled) {
          return;
        }

        window.clearTimeout(timeoutId);
        updateEditorFileState(worktreeId, filePath, () => ({
          savedContent: result.content,
          draftContent: result.content,
          mimeType: result.mimeType,
          loading: false,
          loaded: true,
          saving: false,
          error: null,
        }));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        window.clearTimeout(timeoutId);
        const message = error instanceof DOMException && error.name === "AbortError"
          ? "Loading this file took too long. Please retry."
          : error instanceof Error
            ? error.message
            : "Unable to open file";
        updateEditorFileState(worktreeId, filePath, (current) => ({
          ...current,
          loading: false,
          loaded: false,
          saving: false,
          error: message,
        }));
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [updateEditorFileState]);

  const loadEditorGitBaseline = useCallback((worktreeId: string, filePath: string, versionKey: string) => {
    const currentBaselineState = editorGitBaselineStateRef.current[worktreeId]?.[filePath] ?? createInitialEditorGitBaselineState();
    if (
      (currentBaselineState.loading && currentBaselineState.versionKey === versionKey)
      || (currentBaselineState.loaded && currentBaselineState.versionKey === versionKey)
    ) {
      return () => {};
    }

    const timeoutId = window.setTimeout(() => {
      updateEditorGitBaselineState(worktreeId, filePath, (current) => ({
        ...current,
        loading: false,
        loaded: false,
        error: "Loading git baseline took too long. Please retry.",
      }));
    }, 15_000);

    let cancelled = false;

    updateEditorGitBaselineState(worktreeId, filePath, (current) => ({
      ...current,
      loading: true,
      loaded: false,
      error: null,
      versionKey,
    }));

    void api.getFileContents(worktreeId, filePath)
      .then((result) => {
        if (cancelled) {
          return;
        }

        window.clearTimeout(timeoutId);
        updateEditorGitBaselineState(worktreeId, filePath, () => ({
          headContent: result.oldContent ?? null,
          loading: false,
          loaded: true,
          error: null,
          versionKey,
        }));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        window.clearTimeout(timeoutId);
        updateEditorGitBaselineState(worktreeId, filePath, (current) => ({
          ...current,
          headContent: current.headContent ?? null,
          loading: false,
          loaded: false,
          error: error instanceof Error ? error.message : "Unable to load git baseline",
          versionKey,
        }));
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [updateEditorGitBaselineState]);

  useEffect(() => {
    if (!selectedWorktreeId || !activeFilePath) {
      return;
    }

    if (
      closingActiveFileRef.current
      && closingActiveFileRef.current.worktreeId === selectedWorktreeId
      && closingActiveFileRef.current.filePath === activeFilePath
    ) {
      return;
    }

    void ensureFileTab(selectedWorktreeId, activeFilePath);
  }, [activeFilePath, ensureFileTab, selectedWorktreeId]);

  useEffect(() => {
    if (!closingActiveFileRef.current) {
      return;
    }

    if (
      !selectedWorktreeId
      || !activeFilePath
      || closingActiveFileRef.current.worktreeId !== selectedWorktreeId
      || closingActiveFileRef.current.filePath !== activeFilePath
    ) {
      closingActiveFileRef.current = null;
    }
  }, [activeFilePath, selectedWorktreeId]);

  useEffect(() => {
    if (!selectedWorktreeId || activeView !== "file" || !activeFilePath) {
      return;
    }

    return loadEditorFile(selectedWorktreeId, activeFilePath);
  }, [activeFilePath, activeView, loadEditorFile, selectedWorktreeId]);

  useEffect(() => {
    if (!selectedWorktreeId || activeView !== "file" || !activeFilePath) {
      return;
    }

    return loadEditorGitBaseline(selectedWorktreeId, activeFilePath, activeGitBaselineVersionKey);
  }, [
    activeFilePath,
    activeGitBaselineVersionKey,
    activeView,
    loadEditorGitBaseline,
    selectedWorktreeId,
  ]);

  useEffect(() => {
    const hasDirtyFiles = Object.entries(editorFileStateByWorktreeId).some(([, files]) =>
      Object.values(files).some((state) => state.loaded && state.draftContent !== state.savedContent),
    );

    if (!hasDirtyFiles) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [editorFileStateByWorktreeId]);

  const openReadFile = useCallback(async (filePath: string) => {
    if (!selectedWorktreeId) {
      onError("Worktree is not selected");
      return;
    }

    const normalizedTarget = normalizeOpenFileTarget(filePath);
    if (normalizedTarget.path.length === 0) {
      onError("Unable to resolve file path");
      return;
    }

    if (
      activeView === "file"
      && activeFilePath
      && activeFilePath !== normalizedTarget.path
      && !confirmSwitchAwayFromActiveFile()
    ) {
      return;
    }

    const result = ensureFileTab(selectedWorktreeId, normalizedTarget.path, { pin: false });
    if (!result.ok) {
      return;
    }
    pushRecentFile(selectedWorktreeId, normalizedTarget.path);
    updateSearch({
      view: "file",
      file: normalizedTarget.path,
      fileLine: normalizedTarget.line ?? undefined,
      fileColumn: normalizedTarget.column ?? undefined,
    });
    onError(null);
  }, [activeFilePath, activeView, confirmSwitchAwayFromActiveFile, ensureFileTab, normalizeOpenFileTarget, onError, pushRecentFile, selectedWorktreeId, updateSearch]);

  const closeQuickFilePicker = useCallback(() => {
    setQuickFilePicker({
      open: false,
      query: "",
      selectedIndex: 0,
    });
  }, []);

  const openQuickFilePicker = useCallback(() => {
    if (!selectedWorktreeId) {
      return;
    }

    setQuickFilePicker((current) => ({
      open: true,
      query: current.open ? current.query : "",
      selectedIndex: 0,
    }));
    onOpenQuickFilePicker?.();
  }, [onOpenQuickFilePicker, selectedWorktreeId]);

  const handleQuickFileSelect = useCallback((filePath: string) => {
    closeQuickFilePicker();
    void openReadFile(filePath);
  }, [closeQuickFilePicker, openReadFile]);

  useEffect(() => {
    if (!quickFilePicker.open) {
      return;
    }

    quickFileInputRef.current?.focus();
    quickFileInputRef.current?.select();
  }, [quickFilePicker.open]);

  useEffect(() => {
    if (!quickFilePicker.open) {
      return;
    }

    setQuickFilePicker((current) => {
      if (!current.open) {
        return current;
      }

      const nextIndex = filteredQuickFileItems.length === 0
        ? 0
        : Math.min(current.selectedIndex, filteredQuickFileItems.length - 1);
      return nextIndex === current.selectedIndex ? current : { ...current, selectedIndex: nextIndex };
    });
  }, [filteredQuickFileItems.length, quickFilePicker.open]);

  useEffect(() => {
    setQuickFilePicker({
      open: false,
      query: "",
      selectedIndex: 0,
    });
  }, [selectedWorktreeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        event.stopPropagation();
        openQuickFilePicker();
        return;
      }

      if (event.key === "Escape" && quickFilePicker.open) {
        event.preventDefault();
        closeQuickFilePicker();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeQuickFilePicker, openQuickFilePicker, quickFilePicker.open]);

  const handleSelectFileTab = useCallback((filePath: string) => {
    if (selectedWorktreeId) {
      pushRecentFile(selectedWorktreeId, filePath);
    }
    if (
      activeView === "file"
      && activeFilePath
      && activeFilePath !== filePath
      && !confirmSwitchAwayFromActiveFile()
    ) {
      return;
    }

    updateSearch({ view: "file", file: filePath, fileLine: undefined, fileColumn: undefined });
  }, [activeFilePath, activeView, confirmSwitchAwayFromActiveFile, pushRecentFile, selectedWorktreeId, updateSearch]);

  const handlePinFileTab = useCallback((filePath: string) => {
    if (!selectedWorktreeId) {
      return;
    }

    const result = ensureFileTab(selectedWorktreeId, filePath, { pin: true });
    if (!result.ok) {
      return;
    }

    updateSearch({ view: "file", file: filePath, fileLine: undefined, fileColumn: undefined });
    pushRecentFile(selectedWorktreeId, filePath);
  }, [ensureFileTab, pushRecentFile, selectedWorktreeId, updateSearch]);

  const handleCloseFileTab = useCallback((filePath: string) => {
    const currentWorktreeId = selectedWorktreeId;
    if (!currentWorktreeId) {
      return;
    }

    if (!confirmDiscardDirtyFile(currentWorktreeId, filePath)) {
      return;
    }

    const nextTabs = activeWorktreeFileTabs.filter((tab) => tab.path !== filePath);
    closeFileTabState(currentWorktreeId, filePath);
    setEditorFileStateByWorktreeId((current) => {
      const worktreeState = current[currentWorktreeId] ?? {};
      if (!(filePath in worktreeState)) {
        return current;
      }

      const { [filePath]: _removed, ...rest } = worktreeState;
      return {
        ...current,
        [currentWorktreeId]: rest,
      };
    });
    setEditorGitBaselineStateByWorktreeId((current) => {
      const worktreeState = current[currentWorktreeId] ?? {};
      if (!(filePath in worktreeState)) {
        return current;
      }

      const { [filePath]: _removed, ...rest } = worktreeState;
      return {
        ...current,
        [currentWorktreeId]: rest,
      };
    });

    if (activeFilePath !== filePath) {
      return;
    }

    closingActiveFileRef.current = { worktreeId: currentWorktreeId, filePath };

    const currentIndex = activeWorktreeFileTabs.findIndex((tab) => tab.path === filePath);
    const nextActivePath = nextTabs[Math.min(currentIndex, nextTabs.length - 1)]?.path
      ?? nextTabs[currentIndex - 1]?.path
      ?? null;
    if (nextActivePath) {
      updateSearch({ view: "file", file: nextActivePath, fileLine: undefined, fileColumn: undefined });
      return;
    }

    updateSearch({
      view: undefined,
      file: undefined,
      fileLine: undefined,
      fileColumn: undefined,
      threadId: selectedThreadId ?? undefined,
    });
  }, [activeFilePath, activeWorktreeFileTabs, closeFileTabState, confirmDiscardDirtyFile, selectedThreadId, selectedWorktreeId, updateSearch]);

  const handleEditorDraftChange = useCallback((filePath: string, nextContent: string) => {
    if (!selectedWorktreeId) {
      return;
    }

    const worktreeId = selectedWorktreeId;
    const fileState = getEditorFileState(worktreeId, filePath);
    if (!fileState.loaded) {
      return;
    }

    if (nextContent !== fileState.savedContent) {
      setOpenFileTabsByWorktreeId((current) => {
        const tabs = current[worktreeId] ?? [];
        const targetTab = tabs.find((tab) => tab.path === filePath);

        if (!targetTab || targetTab.pinned) {
          return current;
        }

        return {
          ...current,
          [worktreeId]: tabs.map((tab) =>
            tab.path === filePath ? { ...tab, pinned: true } : tab
          ),
        };
      });
    }

    updateEditorFileState(selectedWorktreeId, filePath, (current) => ({
      ...current,
      draftContent: nextContent,
      error: null,
    }));
  }, [getEditorFileState, selectedWorktreeId, updateEditorFileState]);

  const handleRetryActiveFileLoad = useCallback(() => {
    if (!selectedWorktreeId || !activeFilePath) {
      return;
    }

    updateEditorFileState(selectedWorktreeId, activeFilePath, (current) => ({
      ...current,
      loaded: false,
      loading: false,
      error: null,
    }));
    loadEditorFile(selectedWorktreeId, activeFilePath);
  }, [activeFilePath, loadEditorFile, selectedWorktreeId, updateEditorFileState]);

  const handleSaveActiveFile = useCallback(async () => {
    if (!selectedWorktreeId || !activeFilePath) {
      return;
    }

    const fileState = getEditorFileState(selectedWorktreeId, activeFilePath);
    if (!fileState.loaded || fileState.loading || fileState.saving || fileState.error || fileState.mimeType.startsWith("image/")) {
      return;
    }

    updateEditorFileState(selectedWorktreeId, activeFilePath, (current) => ({
      ...current,
      saving: true,
      error: null,
    }));

    try {
      const result = await api.saveWorktreeFileContent(selectedWorktreeId, {
        path: activeFilePath,
        content: fileState.draftContent,
      });
      updateEditorFileState(selectedWorktreeId, activeFilePath, (current) => ({
        ...current,
        savedContent: result.content,
        draftContent: result.content,
        mimeType: result.mimeType,
        saving: false,
        loaded: true,
        error: null,
      }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(selectedWorktreeId) });
      void queryClient.invalidateQueries({ queryKey: ["worktrees", selectedWorktreeId, "gitBranchDiffSummary"] });
      onError(null);
    } catch (error) {
      updateEditorFileState(selectedWorktreeId, activeFilePath, (current) => ({
        ...current,
        saving: false,
        error: error instanceof Error ? error.message : "Unable to save file",
      }));
    }
  }, [activeFilePath, getEditorFileState, onError, queryClient, selectedWorktreeId, updateEditorFileState]);

  useEffect(() => {
    if (activeView !== "file" || !activeFilePath) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void handleSaveActiveFile();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeFilePath, activeView, handleSaveActiveFile]);

  const handleQuickFileQueryChange = useCallback((value: string) => {
    setQuickFilePicker((current) => ({
      ...current,
      query: value,
      selectedIndex: 0,
    }));
  }, []);

  const handleQuickFileSelectedIndexChange = useCallback((index: number) => {
    setQuickFilePicker((current) => ({ ...current, selectedIndex: index }));
  }, []);

  return {
    activeEditorFileState,
    activeEditorGitBaselineState,
    activeFileDirty,
    canDiscardDirtyWorktreeFiles,
    canSaveActiveFile,
    closeQuickFilePicker,
    confirmSwitchAwayFromActiveFile,
    filteredQuickFileItems,
    handleCloseFileTab,
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
  };
}
