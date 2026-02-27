import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Repository, ScriptResult } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api, TeardownFailedError } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { useRepositories } from "../../../hooks/queries/useRepositories";
import { useCreateRepository } from "../../../hooks/mutations/useCreateRepository";
import { useCreateWorktree } from "../../../hooks/mutations/useCreateWorktree";
import { useDeleteWorktree } from "../../../hooks/mutations/useDeleteWorktree";
import { useDeleteRepository } from "../../../hooks/mutations/useDeleteRepository";
import { useRenameWorktreeBranch } from "../../../hooks/mutations/useRenameWorktreeBranch";
import { findRepositoryByWorktree } from "../eventUtils";
import { findRootWorktree } from "../../../lib/worktree";

export interface TeardownErrorState {
  worktreeId: string;
  worktreeName: string;
  output: string;
}

export interface ScriptUpdateEvent {
  worktreeId: string;
  worktreeName: string;
  type: "setup" | "teardown" | "run";
  status: "running" | "completed";
  result?: ScriptResult;
}

interface UseRepositoryManagerOptions {
  initialRepoId?: string;
  initialWorktreeId?: string;
  onSelectionChange?: (selection: { repoId: string | null; worktreeId: string | null }) => void;
  onScriptUpdate?: (event: ScriptUpdateEvent) => void;
  onScriptOutputChunk?: (event: { worktreeId: string; chunk: string }) => void;
  onTeardownError?: (state: TeardownErrorState) => void;
}

export function useRepositoryManager(
  onError: (msg: string | null) => void,
  options?: UseRepositoryManagerOptions,
) {
  const queryClient = useQueryClient();
  const { data: repositories = [], isLoading: loadingRepos } = useRepositories();

  const createRepoMutation = useCreateRepository();
  const createWorktreeMutation = useCreateWorktree();
  const deleteWorktreeMutation = useDeleteWorktree();
  const deleteRepoMutation = useDeleteRepository();
  const renameBranchMutation = useRenameWorktreeBranch();

  const activeStreamRef = useRef<{ worktreeId: string; eventSource: EventSource } | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);

  // Separate state for run scripts (Run button / ad-hoc commands)
  const runScriptRef = useRef<{ worktreeId: string; eventSource: EventSource } | null>(null);
  const [runScriptRunning, setRunScriptRunning] = useState(false);

  function runSetupStreaming(worktreeId: string, worktreeName: string) {
    options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "setup", status: "running" });

    const es = api.runSetupStream(worktreeId);
    activeStreamRef.current = { worktreeId, eventSource: es };
    setSetupRunning(true);

    es.addEventListener("output", (e) => {
      const { chunk } = JSON.parse(e.data);
      options?.onScriptOutputChunk?.({ worktreeId, chunk });
    });

    es.addEventListener("done", (e) => {
      const { success } = JSON.parse(e.data);
      options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "setup", status: "completed", result: { success, output: "" } });
      es.close();
      activeStreamRef.current = null;
      setSetupRunning(false);
    });

    es.onerror = () => {
      options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "setup", status: "completed", result: { success: false, output: "Connection lost" } });
      es.close();
      activeStreamRef.current = null;
      setSetupRunning(false);
    };
  }

  async function stopSetup() {
    const stream = activeStreamRef.current;
    if (stream) {
      await api.stopSetupScript(stream.worktreeId);
      stream.eventSource.close();
      activeStreamRef.current = null;
      setSetupRunning(false);
    }
  }

  function startRunScriptStream(worktreeId: string, cmd?: string) {
    // Stop any existing run script stream first
    if (runScriptRef.current) {
      runScriptRef.current.eventSource.close();
      runScriptRef.current = null;
    }

    // Look up worktree name
    let worktreeName = worktreeId;
    for (const repo of repositories) {
      const wt = repo.worktrees.find((w) => w.id === worktreeId);
      if (wt) { worktreeName = wt.branch; break; }
    }

    options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "run", status: "running" });

    const es = api.runScriptStream(worktreeId, cmd);
    runScriptRef.current = { worktreeId, eventSource: es };
    setRunScriptRunning(true);

    es.addEventListener("output", (e) => {
      const { chunk } = JSON.parse(e.data);
      options?.onScriptOutputChunk?.({ worktreeId, chunk });
    });

    es.addEventListener("done", (e) => {
      const { success } = JSON.parse(e.data);
      options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "run", status: "completed", result: { success, output: "" } });
      es.close();
      runScriptRef.current = null;
      setRunScriptRunning(false);
    });

    es.onerror = () => {
      options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "run", status: "completed", result: { success: false, output: "Connection lost" } });
      es.close();
      runScriptRef.current = null;
      setRunScriptRunning(false);
    };
  }

  function runSavedScript(worktreeId: string) {
    startRunScriptStream(worktreeId);
  }

  function runAdHocCommand(worktreeId: string, cmd: string) {
    startRunScriptStream(worktreeId, cmd);
  }

  async function stopRunScript() {
    const stream = runScriptRef.current;
    if (stream) {
      await api.stopRunScript(stream.worktreeId);
      // Look up worktree name for the update
      let worktreeName = stream.worktreeId;
      for (const repo of repositories) {
        const wt = repo.worktrees.find((w) => w.id === stream.worktreeId);
        if (wt) { worktreeName = wt.branch; break; }
      }
      options?.onScriptUpdate?.({ worktreeId: stream.worktreeId, worktreeName, type: "run", status: "completed", result: { success: false, output: "" } });
      stream.eventSource.close();
      runScriptRef.current = null;
      setRunScriptRunning(false);
    }
  }

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);

  const initialAppliedRef = useRef(false);
  const prevSelectionRef = useRef<{ repoId: string | null; worktreeId: string | null }>({
    repoId: null,
    worktreeId: null,
  });

  const selectedRepository = useMemo(() => {
    if (selectedRepositoryId) {
      return repositories.find((r) => r.id === selectedRepositoryId) ?? null;
    }
    return findRepositoryByWorktree(repositories, selectedWorktreeId);
  }, [repositories, selectedRepositoryId, selectedWorktreeId]);

  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) return null;
    for (const repo of repositories) {
      const found = repo.worktrees.find((w) => w.id === selectedWorktreeId);
      if (found) return found;
    }
    return null;
  }, [repositories, selectedWorktreeId]);

  function findPrimaryWorktreeId(repository: Repository): string | null {
    const primary = findRootWorktree(repository);
    return primary?.id ?? null;
  }

  // Auto-select first repo/worktree when data arrives, respecting initial URL IDs
  useEffect(() => {
    if (repositories.length === 0) return;

    if (!initialAppliedRef.current && (options?.initialWorktreeId || options?.initialRepoId)) {
      initialAppliedRef.current = true;

      // Validate initialWorktreeId against fetched data
      if (options.initialWorktreeId) {
        let foundRepo: Repository | undefined;
        for (const repo of repositories) {
          if (repo.worktrees.some((w) => w.id === options.initialWorktreeId)) {
            foundRepo = repo;
            break;
          }
        }
        if (foundRepo) {
          setSelectedRepositoryId(foundRepo.id);
          setSelectedWorktreeId(options.initialWorktreeId);
          return;
        }
      }

      // Validate initialRepoId against fetched data
      if (options.initialRepoId) {
        const repo = repositories.find((r) => r.id === options.initialRepoId);
        if (repo) {
          setSelectedRepositoryId(repo.id);
          const primaryWorktreeId = findPrimaryWorktreeId(repo);
          if (primaryWorktreeId) {
            setSelectedWorktreeId(primaryWorktreeId);
          } else {
            const firstWorktree = repo.worktrees[0];
            if (firstWorktree) setSelectedWorktreeId(firstWorktree.id);
          }
          return;
        }
      }
      // Fall through to auto-select if URL IDs were invalid
    }

    if (!initialAppliedRef.current) {
      initialAppliedRef.current = true;
    }

    if (!selectedRepositoryId && repositories[0]) {
      setSelectedRepositoryId(repositories[0].id);
    }
    if (!selectedWorktreeId) {
      const firstRepo = repositories[0];
      if (firstRepo) {
        const primaryWorktreeId = findPrimaryWorktreeId(firstRepo);
        if (primaryWorktreeId) {
          setSelectedWorktreeId(primaryWorktreeId);
        } else {
          const firstWorktree = firstRepo.worktrees[0];
          if (firstWorktree) setSelectedWorktreeId(firstWorktree.id);
        }
      }
    }
  }, [repositories, selectedRepositoryId, selectedWorktreeId]);

  // Notify parent when selection changes
  useEffect(() => {
    const prev = prevSelectionRef.current;
    const willFire = prev.repoId !== selectedRepositoryId || prev.worktreeId !== selectedWorktreeId;
    if (willFire) {
      prevSelectionRef.current = { repoId: selectedRepositoryId, worktreeId: selectedWorktreeId };
      options?.onSelectionChange?.({ repoId: selectedRepositoryId, worktreeId: selectedWorktreeId });
    }
  }, [selectedRepositoryId, selectedWorktreeId]);

  async function attachRepository() {
    onError(null);
    try {
      let path = "";
      try {
        const picked = await api.pickDirectory();
        path = picked.path.trim();
      } catch {
        const manualPath =
          typeof window === "undefined"
            ? null
            : window.prompt("Enter the repository path on the runtime machine", "");
        path = manualPath?.trim() ?? "";
      }
      if (!path) return;
      await createRepoMutation.mutateAsync({ path });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add repository");
    }
  }

  function openFileBrowser() {
    setFileBrowserOpen(true);
  }

  async function attachRepositoryFromPath(path: string) {
    onError(null);
    try {
      await createRepoMutation.mutateAsync({ path });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add repository");
    }
  }

  async function submitWorktree(repositoryId: string) {
    onError(null);
    try {
      const { worktree } = await createWorktreeMutation.mutateAsync({ repositoryId });
      setSelectedWorktreeId(worktree.id);
      setSelectedRepositoryId(repositoryId);
      // Fire setup scripts in background — does not block worktree creation
      runSetupStreaming(worktree.id, worktree.branch);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create worktree");
    }
  }

  async function removeWorktree(worktreeId: string) {
    onError(null);
    // Find the worktree name before deletion for error UI
    let worktreeName = worktreeId;
    for (const repo of repositories) {
      const wt = repo.worktrees.find((w) => w.id === worktreeId);
      if (wt) { worktreeName = wt.branch; break; }
    }
    try {
      await deleteWorktreeMutation.mutateAsync(worktreeId);
      if (selectedWorktreeId === worktreeId) {
        setSelectedWorktreeId(null);
      }
    } catch (e) {
      if (e instanceof TeardownFailedError) {
        options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "teardown", status: "completed", result: { success: false, output: e.output } });
        options?.onTeardownError?.({ worktreeId, worktreeName, output: e.output });
      } else {
        onError(e instanceof Error ? e.message : "Failed to delete worktree");
      }
    }
  }

  async function removeRepository(repositoryId: string) {
    onError(null);
    try {
      await deleteRepoMutation.mutateAsync(repositoryId);
      if (selectedRepositoryId === repositoryId) {
        setSelectedRepositoryId(null);
        setSelectedWorktreeId(null);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete repository");
    }
  }

  async function renameWorktreeBranch(worktreeId: string, newBranch: string) {
    onError(null);
    try {
      await renameBranchMutation.mutateAsync({ worktreeId, input: { branch: newBranch } });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to rename branch");
    }
  }

  async function rerunSetup(worktreeId: string) {
    onError(null);
    let worktreeName = worktreeId;
    for (const repo of repositories) {
      const wt = repo.worktrees.find((w) => w.id === worktreeId);
      if (wt) { worktreeName = wt.branch; break; }
    }
    runSetupStreaming(worktreeId, worktreeName);
  }

  const updateWorktreeBranch = useCallback((worktreeId: string, newBranch: string) => {
    queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (old) =>
      old?.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((wt) =>
          wt.id === worktreeId ? { ...wt, branch: newBranch } : wt,
        ),
      })),
    );
  }, [queryClient]);

  return {
    repositories,
    selectedRepositoryId,
    selectedWorktreeId,
    selectedRepository,
    selectedWorktree,
    loadingRepos,
    submittingRepo: createRepoMutation.isPending,
    submittingWorktree: createWorktreeMutation.isPending,
    setSelectedRepositoryId,
    setSelectedWorktreeId,
    attachRepository,
    openFileBrowser,
    attachRepositoryFromPath,
    fileBrowserOpen,
    setFileBrowserOpen,
    submitWorktree,
    removeWorktree,
    removeRepository,
    rerunSetup,
    runSavedScript,
    runAdHocCommand,
    stopSetup,
    stopRunScript,
    setupRunning,
    runScriptRunning,
    renameWorktreeBranch,
    updateWorktreeBranch,
  };
}
