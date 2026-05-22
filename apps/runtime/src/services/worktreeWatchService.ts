import { execFile as execFileRaw } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WorktreeStatus } from "@codesymphony/shared-types";
import type { WorkspaceSyncEventHub } from "../types.js";
import { publishWorktreeActivity, WORKTREE_ACTIVITY } from "./worktreeActivity.js";

const execFile = promisify(execFileRaw);

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_RESCAN_INTERVAL_MS = 30_000;

type WatchedWorktree = {
  id: string;
  repositoryId: string;
  path: string;
  status: WorktreeStatus;
};

type ActiveWatch = {
  worktree: WatchedWorktree;
  rootWatcher: FSWatcher;
  gitWatcher: FSWatcher;
};

type PendingBatch = {
  filesDirty: boolean;
  gitDirty: boolean;
};

function isOperationalWorktreeStatus(status: WorktreeStatus): boolean {
  return status === "active" || status === "delete_failed";
}

function toAbsoluteGitDir(worktreePath: string, rawGitDir: string): string {
  return path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(worktreePath, rawGitDir);
}

function normalizeRelativePath(filename: string | Buffer | null): string | null {
  if (typeof filename === "string") {
    return filename.split(path.sep).join("/");
  }
  if (Buffer.isBuffer(filename)) {
    return filename.toString("utf8").split(path.sep).join("/");
  }
  return null;
}

function isGitRelativePath(relativePath: string | null): boolean {
  if (!relativePath) {
    return false;
  }

  return relativePath === ".git" || relativePath.startsWith(".git/");
}

function startFsWatch(
  targetPath: string,
  onChange: (eventType: string, filename: string | Buffer | null) => void,
): FSWatcher | null {
  try {
    return watch(targetPath, { recursive: true }, onChange);
  } catch {
    try {
      return watch(targetPath, onChange);
    } catch {
      return null;
    }
  }
}

export function createWorktreeWatchService(options: {
  workspaceEventHub: WorkspaceSyncEventHub;
  listWorktrees: () => Promise<WatchedWorktree[]>;
  onFilesChanged?: (worktree: WatchedWorktree) => void;
  onGitChanged?: (worktree: WatchedWorktree) => void;
  debounceMs?: number;
  rescanIntervalMs?: number;
}) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const rescanIntervalMs = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
  const watches = new Map<string, ActiveWatch>();
  const pendingBatches = new Map<string, PendingBatch>();
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let refreshPromise: Promise<void> | null = null;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let unsubscribeWorkspaceEvents: (() => void) | null = null;

  function getOrCreatePendingBatch(worktreeId: string): PendingBatch {
    const existing = pendingBatches.get(worktreeId);
    if (existing) {
      return existing;
    }

    const created = {
      filesDirty: false,
      gitDirty: false,
    };
    pendingBatches.set(worktreeId, created);
    return created;
  }

  function flushWorktree(worktreeId: string) {
    flushTimers.delete(worktreeId);
    const pending = pendingBatches.get(worktreeId);
    pendingBatches.delete(worktreeId);
    const activeWatch = watches.get(worktreeId);
    if (!pending || !activeWatch) {
      return;
    }

    if (pending.filesDirty) {
      publishWorktreeActivity({
        workspaceEventHub: options.workspaceEventHub,
        worktree: activeWatch.worktree,
        activity: WORKTREE_ACTIVITY.WATCHER_FILES_CHANGED,
        onFilesChanged: () => {
          options.onFilesChanged?.(activeWatch.worktree);
        },
        onGitChanged: () => {
          options.onGitChanged?.(activeWatch.worktree);
        },
      });
      return;
    }

    if (pending.gitDirty) {
      publishWorktreeActivity({
        workspaceEventHub: options.workspaceEventHub,
        worktree: activeWatch.worktree,
        activity: WORKTREE_ACTIVITY.WATCHER_GIT_CHANGED,
        onGitChanged: () => {
          options.onGitChanged?.(activeWatch.worktree);
        },
      });
    }
  }

  function scheduleFlush(worktreeId: string) {
    const existing = flushTimers.get(worktreeId);
    if (existing) {
      clearTimeout(existing);
    }

    flushTimers.set(worktreeId, setTimeout(() => {
      flushWorktree(worktreeId);
    }, debounceMs));
  }

  function markFilesChanged(worktreeId: string) {
    const pending = getOrCreatePendingBatch(worktreeId);
    pending.filesDirty = true;
    pending.gitDirty = true;
    scheduleFlush(worktreeId);
  }

  function markGitChanged(worktreeId: string) {
    const pending = getOrCreatePendingBatch(worktreeId);
    pending.gitDirty = true;
    scheduleFlush(worktreeId);
  }

  function stopWatching(worktreeId: string) {
    const activeWatch = watches.get(worktreeId);
    if (!activeWatch) {
      return;
    }

    activeWatch.rootWatcher.close();
    activeWatch.gitWatcher.close();
    watches.delete(worktreeId);

    const flushTimer = flushTimers.get(worktreeId);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimers.delete(worktreeId);
    }
    pendingBatches.delete(worktreeId);
  }

  async function startWatching(worktree: WatchedWorktree): Promise<void> {
    if (closed) {
      return;
    }

    const existing = watches.get(worktree.id);
    if (existing && existing.worktree.path === worktree.path) {
      existing.worktree = worktree;
      return;
    }
    if (existing) {
      stopWatching(worktree.id);
    }

    let gitDir: string;
    try {
      const { stdout } = await execFile("git", ["rev-parse", "--git-dir"], { cwd: worktree.path });
      gitDir = toAbsoluteGitDir(worktree.path, stdout.trim() || ".git");
    } catch {
      return;
    }

    if (closed) {
      return;
    }

    const rootWatcher = startFsWatch(worktree.path, (_eventType, filename) => {
      const relativePath = normalizeRelativePath(filename);
      if (isGitRelativePath(relativePath)) {
        markGitChanged(worktree.id);
        return;
      }
      markFilesChanged(worktree.id);
    });
    const gitWatcher = startFsWatch(gitDir, () => {
      markGitChanged(worktree.id);
    });
    if (!rootWatcher || !gitWatcher) {
      rootWatcher?.close();
      gitWatcher?.close();
      return;
    }

    const handleWatcherError = () => {
      stopWatching(worktree.id);
      void refresh();
    };

    rootWatcher.on("error", handleWatcherError);
    gitWatcher.on("error", handleWatcherError);

    watches.set(worktree.id, {
      worktree,
      rootWatcher,
      gitWatcher,
    });
  }

  async function refresh() {
    if (closed) {
      return;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      try {
        const worktrees = (await options.listWorktrees()).filter((worktree) => isOperationalWorktreeStatus(worktree.status));
        const nextIds = new Set(worktrees.map((worktree) => worktree.id));

        for (const existingId of watches.keys()) {
          if (!nextIds.has(existingId)) {
            stopWatching(existingId);
          }
        }

        for (const worktree of worktrees) {
          await startWatching(worktree);
        }
      } catch {
        // Best-effort watcher maintenance; fallback polling still exists client-side.
      }
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  }

  function start() {
    if (closed || rescanTimer) {
      return;
    }

    void refresh();
    rescanTimer = setInterval(() => {
      void refresh();
    }, rescanIntervalMs);
    unsubscribeWorkspaceEvents = options.workspaceEventHub.subscribe((event) => {
      if (
        event.type === "worktree.created"
        || event.type === "worktree.updated"
        || event.type === "worktree.deletion_started"
        || event.type === "worktree.deletion_failed"
        || event.type === "worktree.deleted"
      ) {
        void refresh();
      }
    });
  }

  function dispose() {
    closed = true;
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    unsubscribeWorkspaceEvents?.();
    unsubscribeWorkspaceEvents = null;

    for (const flushTimer of flushTimers.values()) {
      clearTimeout(flushTimer);
    }
    flushTimers.clear();
    pendingBatches.clear();

    for (const worktreeId of [...watches.keys()]) {
      stopWatching(worktreeId);
    }
  }

  return {
    start,
    refresh,
    dispose,
  };
}
