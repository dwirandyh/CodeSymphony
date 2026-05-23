import type { WorkspaceSyncEventType } from "@codesymphony/shared-types";
import type { WorkspaceSyncEventHub } from "../types.js";
import { invalidateCachedWorktreeGitData } from "./worktreeGitQueryCache.js";

export const WORKTREE_ACTIVITY = {
  FILE_SAVED: "file_saved",
  GIT_COMMITTED: "git_committed",
  GIT_SYNCED: "git_synced",
  GIT_DISCARDED: "git_discarded",
  WATCHER_FILES_CHANGED: "watcher_files_changed",
  WATCHER_GIT_CHANGED: "watcher_git_changed",
} as const;

export type WorktreeActivity = typeof WORKTREE_ACTIVITY[keyof typeof WORKTREE_ACTIVITY];

type WorktreeActivityEffect = {
  emitEventTypes: WorkspaceSyncEventType[];
  invalidatesGitCache: boolean;
  runsFilesChangedHook: boolean;
  runsGitChangedHook: boolean;
};

type WorktreeActivityTarget = {
  id: string;
  repositoryId: string;
};

const WORKTREE_ACTIVITY_EFFECTS: Record<WorktreeActivity, WorktreeActivityEffect> = {
  [WORKTREE_ACTIVITY.FILE_SAVED]: {
    emitEventTypes: ["worktree.updated"],
    invalidatesGitCache: true,
    runsFilesChangedHook: false,
    runsGitChangedHook: false,
  },
  [WORKTREE_ACTIVITY.GIT_COMMITTED]: {
    emitEventTypes: ["worktree.updated"],
    invalidatesGitCache: true,
    runsFilesChangedHook: false,
    runsGitChangedHook: false,
  },
  [WORKTREE_ACTIVITY.GIT_SYNCED]: {
    emitEventTypes: ["worktree.updated"],
    invalidatesGitCache: true,
    runsFilesChangedHook: false,
    runsGitChangedHook: false,
  },
  [WORKTREE_ACTIVITY.GIT_DISCARDED]: {
    emitEventTypes: ["worktree.updated"],
    invalidatesGitCache: true,
    runsFilesChangedHook: false,
    runsGitChangedHook: false,
  },
  [WORKTREE_ACTIVITY.WATCHER_FILES_CHANGED]: {
    emitEventTypes: ["worktree.files.updated", "worktree.git.updated"],
    invalidatesGitCache: true,
    runsFilesChangedHook: true,
    runsGitChangedHook: true,
  },
  [WORKTREE_ACTIVITY.WATCHER_GIT_CHANGED]: {
    emitEventTypes: ["worktree.git.updated"],
    invalidatesGitCache: true,
    runsFilesChangedHook: false,
    runsGitChangedHook: true,
  },
};

export function publishWorktreeActivity(params: {
  workspaceEventHub: WorkspaceSyncEventHub;
  worktree: WorktreeActivityTarget;
  activity: WorktreeActivity;
  onFilesChanged?: () => void;
  onGitChanged?: () => void;
}) {
  const effect = WORKTREE_ACTIVITY_EFFECTS[params.activity];

  if (effect.runsFilesChangedHook) {
    params.onFilesChanged?.();
  }

  if (effect.invalidatesGitCache) {
    invalidateCachedWorktreeGitData(params.worktree.id);
  }

  if (effect.runsGitChangedHook) {
    params.onGitChanged?.();
  }

  for (const eventType of effect.emitEventTypes) {
    params.workspaceEventHub.emit(eventType, {
      repositoryId: params.worktree.repositoryId,
      worktreeId: params.worktree.id,
    });
  }
}
