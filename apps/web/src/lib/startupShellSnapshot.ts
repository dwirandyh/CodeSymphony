import type { Repository, WorktreeStatus } from "@codesymphony/shared-types";

export const STARTUP_SHELL_SNAPSHOT_VERSION = 1;
export const STARTUP_SHELL_SNAPSHOT_STORAGE_KEY = "codesymphony:workspace:startup-shell:v1";
export const WORKSPACE_SHELL_STATE_ROW_ID = "workspace-shell";

export type StartupShellWorktreeSnapshot = {
  id: string;
  repositoryId: string;
  branch: string;
  path: string;
  baseBranch: string;
  status: WorktreeStatus;
  branchRenamed: boolean;
};

export type StartupShellRepositorySnapshot = {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  worktrees: StartupShellWorktreeSnapshot[];
};

export type StartupShellSnapshot = {
  version: 1;
  capturedAt: string;
  repoId: string | null;
  repoName: string | null;
  worktreeId: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  worktreeStatus: string | null;
  threadId: string | null;
  threadTitle: string | null;
  threadStatus: string | null;
  repositories?: StartupShellRepositorySnapshot[];
  hiddenRepositoryIds?: string[];
  expandedRepositoryIds?: string[];
};

declare global {
  interface Window {
    __CS_STARTUP_IGNORE_STORED_SNAPSHOT__?: boolean;
    __CS_STARTUP_SHELL_SNAPSHOT_OVERRIDE__?: Partial<StartupShellSnapshot> | string | null;
  }
}

type StartupShellSnapshotInput = Omit<StartupShellSnapshot, "version" | "capturedAt"> & {
  capturedAt?: string;
};

type StartupShellSnapshotFallbackMergeInput = {
  liveInput: StartupShellSnapshotInput;
  fallbackSnapshot: StartupShellSnapshot | null;
  preserveRepoFallback?: boolean;
  preserveWorktreeFallback?: boolean;
  preserveThreadFallback?: boolean;
};

type StartupShellSnapshotStorageRow = StartupShellSnapshot & {
  id: typeof WORKSPACE_SHELL_STATE_ROW_ID;
};

type StartupShellSnapshotStoredItem = {
  versionKey: string;
  data: StartupShellSnapshotStorageRow;
};

type PersistedStartupShellSnapshotReadResult = {
  snapshot: StartupShellSnapshot | null;
  needsMigration: boolean;
};

const STARTUP_SHELL_SNAPSHOT_STORAGE_ROW_KEY = `s:${WORKSPACE_SHELL_STATE_ROW_ID}`;
const STARTUP_SHELL_ALLOWED_WORKTREE_STATUSES = new Set<WorktreeStatus>([
  "active",
  "archived",
  "creating",
  "create_failed",
  "deleting",
  "delete_failed",
]);

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalizedValues: string[] = [];

  for (const entry of value) {
    const normalizedEntry = normalizeNullableString(entry);
    if (!normalizedEntry || seen.has(normalizedEntry)) {
      continue;
    }
    seen.add(normalizedEntry);
    normalizedValues.push(normalizedEntry);
  }

  return normalizedValues;
}

function normalizeStartupShellWorktreeSnapshot(
  value: unknown,
): StartupShellWorktreeSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const worktree = value as Partial<StartupShellWorktreeSnapshot>;
  const id = normalizeNullableString(worktree.id);
  const repositoryId = normalizeNullableString(worktree.repositoryId);
  const branch = normalizeNullableString(worktree.branch);
  const path = normalizeNullableString(worktree.path);
  const baseBranch = normalizeNullableString(worktree.baseBranch);
  const status = normalizeNullableString(worktree.status);

  if (!id || !repositoryId || !branch || !path || !baseBranch || !status) {
    return null;
  }

  if (!STARTUP_SHELL_ALLOWED_WORKTREE_STATUSES.has(status as WorktreeStatus)) {
    return null;
  }

  return {
    id,
    repositoryId,
    branch,
    path,
    baseBranch,
    status: status as WorktreeStatus,
    branchRenamed: worktree.branchRenamed === true,
  };
}

function normalizeStartupShellRepositorySnapshot(
  value: unknown,
): StartupShellRepositorySnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const repository = value as Partial<StartupShellRepositorySnapshot>;
  const id = normalizeNullableString(repository.id);
  const name = normalizeNullableString(repository.name);
  const rootPath = normalizeNullableString(repository.rootPath);
  const defaultBranch = normalizeNullableString(repository.defaultBranch);

  if (!id || !name || !rootPath || !defaultBranch) {
    return null;
  }

  const worktrees = Array.isArray(repository.worktrees)
    ? repository.worktrees.flatMap((worktree) => {
      const normalizedWorktree = normalizeStartupShellWorktreeSnapshot(worktree);
      return normalizedWorktree ? [normalizedWorktree] : [];
    })
    : [];

  return {
    id,
    name,
    rootPath,
    defaultBranch,
    worktrees,
  };
}

function normalizeStartupShellRepositorySnapshots(
  value: unknown,
): StartupShellRepositorySnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const repositories: StartupShellRepositorySnapshot[] = [];

  for (const entry of value) {
    const normalizedRepository = normalizeStartupShellRepositorySnapshot(entry);
    if (!normalizedRepository || seen.has(normalizedRepository.id)) {
      continue;
    }
    seen.add(normalizedRepository.id);
    repositories.push(normalizedRepository);
  }

  return repositories;
}

export function buildStartupShellRepositorySnapshots(
  repositories: Repository[],
): StartupShellRepositorySnapshot[] {
  return repositories.map((repository) => ({
    id: repository.id,
    name: repository.name,
    rootPath: repository.rootPath,
    defaultBranch: repository.defaultBranch,
    worktrees: repository.worktrees.map((worktree) => ({
      id: worktree.id,
      repositoryId: worktree.repositoryId,
      branch: worktree.branch,
      path: worktree.path,
      baseBranch: worktree.baseBranch,
      status: worktree.status,
      branchRenamed: worktree.branchRenamed,
    })),
  }));
}

function createStartupShellSnapshotVersionKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toStartupShellSnapshotStorageRow(
  snapshot: StartupShellSnapshot,
): StartupShellSnapshotStorageRow {
  return {
    id: WORKSPACE_SHELL_STATE_ROW_ID,
    ...snapshot,
  };
}

function parseStoredStartupShellSnapshotRow(value: unknown): StartupShellSnapshot | null {
  if (!value || typeof value !== "object" || !("data" in value)) {
    return null;
  }

  const row = (value as StartupShellSnapshotStoredItem).data;
  return restoreStartupShellSnapshot(row);
}

function readPersistedStartupShellSnapshotFromStorage(
  storage: Pick<Storage, "getItem">,
): PersistedStartupShellSnapshotReadResult {
  try {
    const raw = storage.getItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return { snapshot: null, needsMigration: false };
    }

    const parsed = JSON.parse(raw) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const preferredSnapshot = parseStoredStartupShellSnapshotRow(
        (parsed as Record<string, unknown>)[STARTUP_SHELL_SNAPSHOT_STORAGE_ROW_KEY],
      );
      if (preferredSnapshot) {
        return { snapshot: preferredSnapshot, needsMigration: false };
      }

      for (const value of Object.values(parsed as Record<string, unknown>)) {
        const snapshot = parseStoredStartupShellSnapshotRow(value);
        if (snapshot) {
          return { snapshot, needsMigration: false };
        }
      }
    }

    const legacySnapshot = restoreStartupShellSnapshot(parsed as Partial<StartupShellSnapshot> | null);
    return {
      snapshot: legacySnapshot,
      needsMigration: legacySnapshot != null,
    };
  } catch {
    return { snapshot: null, needsMigration: false };
  }
}

function readStartupShellSnapshotOverride(): StartupShellSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  const override = window.__CS_STARTUP_SHELL_SNAPSHOT_OVERRIDE__;
  if (override == null) {
    return null;
  }

  if (typeof override === "string") {
    const normalized = override.trim();
    if (normalized.length === 0) {
      return null;
    }

    try {
      return restoreStartupShellSnapshot(JSON.parse(normalized) as Partial<StartupShellSnapshot>);
    } catch {
      return null;
    }
  }

  if (typeof override === "object") {
    return restoreStartupShellSnapshot(override);
  }

  return null;
}

function shouldIgnoreStoredStartupShellSnapshot() {
  return typeof window !== "undefined" && window.__CS_STARTUP_IGNORE_STORED_SNAPSHOT__ === true;
}

export function hasStartupShellSnapshot(snapshot: StartupShellSnapshot | null): boolean {
  return !!(
    snapshot
    && (
      snapshot.repoId
      || snapshot.worktreeId
      || snapshot.threadId
      || snapshot.repoName
      || snapshot.worktreeBranch
      || snapshot.threadTitle
      || (snapshot.repositories?.length ?? 0) > 0
    )
  );
}

export function resolveStartupWorkspaceSelection(params: {
  repoId?: string;
  worktreeId?: string;
  threadId?: string;
  snapshot: StartupShellSnapshot | null;
}) {
  const repoId = params.repoId ?? params.snapshot?.repoId ?? undefined;
  const snapshotWorktreeMatchesRepo = params.snapshot?.repoId == null || repoId === params.snapshot.repoId;
  const worktreeId = params.worktreeId ?? (snapshotWorktreeMatchesRepo ? params.snapshot?.worktreeId : undefined) ?? undefined;
  const snapshotThreadMatchesWorktree = params.snapshot?.worktreeId == null || worktreeId === params.snapshot.worktreeId;
  const threadId = params.threadId ?? (snapshotThreadMatchesWorktree ? params.snapshot?.threadId : undefined) ?? undefined;

  return {
    repoId,
    worktreeId,
    threadId,
  };
}

function matchesDesiredId(snapshotId: string | null, desiredId: string | null | undefined) {
  return !!snapshotId && snapshotId === (desiredId ?? null);
}

function hasLiveText(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveStartupShellFallbackState(params: {
  snapshot: StartupShellSnapshot | null;
  desiredRepoId?: string | null;
  desiredWorktreeId?: string | null;
  desiredThreadId?: string | null;
  liveRepoId?: string | null;
  liveRepoName?: string | null;
  liveWorktreeId?: string | null;
  liveWorktreeBranch?: string | null;
  liveWorktreePath?: string | null;
  liveThreadId?: string | null;
  liveThreadTitle?: string | null;
}) {
  const { snapshot } = params;
  if (!snapshot) {
    return {
      snapshot: null,
      repoFallbackActive: false,
      worktreeFallbackActive: false,
      threadFallbackActive: false,
    };
  }

  const repoFallbackActive = matchesDesiredId(snapshot.repoId, params.desiredRepoId)
    && (
      params.liveRepoId !== params.desiredRepoId
      || !hasLiveText(params.liveRepoName)
    );
  const worktreeFallbackActive = matchesDesiredId(snapshot.worktreeId, params.desiredWorktreeId)
    && (
      params.liveWorktreeId !== params.desiredWorktreeId
      || (!hasLiveText(params.liveWorktreeBranch) && !hasLiveText(params.liveWorktreePath))
    );
  const threadFallbackActive = matchesDesiredId(snapshot.threadId, params.desiredThreadId)
    && (
      params.liveThreadId !== params.desiredThreadId
      || !hasLiveText(params.liveThreadTitle)
    );

  return {
    snapshot: repoFallbackActive || worktreeFallbackActive || threadFallbackActive ? snapshot : null,
    repoFallbackActive,
    worktreeFallbackActive,
    threadFallbackActive,
  };
}

export function mergeStartupShellSnapshotInputFromFallback(
  params: StartupShellSnapshotFallbackMergeInput,
): StartupShellSnapshotInput {
  const {
    liveInput,
    fallbackSnapshot,
    preserveRepoFallback = false,
    preserveWorktreeFallback = false,
    preserveThreadFallback = false,
  } = params;

  return {
    capturedAt: liveInput.capturedAt,
    repoId: liveInput.repoId ?? (preserveRepoFallback ? fallbackSnapshot?.repoId ?? null : null),
    repoName: liveInput.repoName ?? (preserveRepoFallback ? fallbackSnapshot?.repoName ?? null : null),
    worktreeId: liveInput.worktreeId ?? (preserveWorktreeFallback ? fallbackSnapshot?.worktreeId ?? null : null),
    worktreeBranch: liveInput.worktreeBranch ?? (preserveWorktreeFallback ? fallbackSnapshot?.worktreeBranch ?? null : null),
    worktreePath: liveInput.worktreePath ?? (preserveWorktreeFallback ? fallbackSnapshot?.worktreePath ?? null : null),
    worktreeStatus: liveInput.worktreeStatus ?? (preserveWorktreeFallback ? fallbackSnapshot?.worktreeStatus ?? null : null),
    threadId: liveInput.threadId ?? (preserveThreadFallback ? fallbackSnapshot?.threadId ?? null : null),
    threadTitle: liveInput.threadTitle ?? (preserveThreadFallback ? fallbackSnapshot?.threadTitle ?? null : null),
    threadStatus: liveInput.threadStatus ?? (preserveThreadFallback ? fallbackSnapshot?.threadStatus ?? null : null),
  };
}

export function buildStartupShellSnapshot(input: StartupShellSnapshotInput): StartupShellSnapshot | null {
  const repositories = normalizeStartupShellRepositorySnapshots(input.repositories);
  const validRepositoryIds = new Set(repositories.map((repository) => repository.id));
  const hiddenRepositoryIds = normalizeStringArray(input.hiddenRepositoryIds)
    .filter((repositoryId) => validRepositoryIds.has(repositoryId));
  const expandedRepositoryIds = normalizeStringArray(input.expandedRepositoryIds)
    .filter((repositoryId) => validRepositoryIds.has(repositoryId));

  const snapshot: StartupShellSnapshot = {
    version: STARTUP_SHELL_SNAPSHOT_VERSION,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    repoId: normalizeNullableString(input.repoId),
    repoName: normalizeNullableString(input.repoName),
    worktreeId: normalizeNullableString(input.worktreeId),
    worktreeBranch: normalizeNullableString(input.worktreeBranch),
    worktreePath: normalizeNullableString(input.worktreePath),
    worktreeStatus: normalizeNullableString(input.worktreeStatus),
    threadId: normalizeNullableString(input.threadId),
    threadTitle: normalizeNullableString(input.threadTitle),
    threadStatus: normalizeNullableString(input.threadStatus),
    ...(repositories.length > 0 ? { repositories } : {}),
    ...(hiddenRepositoryIds.length > 0 ? { hiddenRepositoryIds } : {}),
    ...(expandedRepositoryIds.length > 0 ? { expandedRepositoryIds } : {}),
  };

  return hasStartupShellSnapshot(snapshot) ? snapshot : null;
}

export function restoreStartupShellSnapshot(
  snapshot: Partial<StartupShellSnapshot> | null | undefined,
): StartupShellSnapshot | null {
  if (!snapshot || snapshot.version !== STARTUP_SHELL_SNAPSHOT_VERSION || typeof snapshot.capturedAt !== "string") {
    return null;
  }

  return buildStartupShellSnapshot({
    capturedAt: snapshot.capturedAt,
    repoId: snapshot.repoId ?? null,
    repoName: snapshot.repoName ?? null,
    worktreeId: snapshot.worktreeId ?? null,
    worktreeBranch: snapshot.worktreeBranch ?? null,
    worktreePath: snapshot.worktreePath ?? null,
    worktreeStatus: snapshot.worktreeStatus ?? null,
    threadId: snapshot.threadId ?? null,
    threadTitle: snapshot.threadTitle ?? null,
    threadStatus: snapshot.threadStatus ?? null,
    repositories: snapshot.repositories,
    hiddenRepositoryIds: snapshot.hiddenRepositoryIds,
    expandedRepositoryIds: snapshot.expandedRepositoryIds,
  });
}

export function loadStartupShellSnapshot(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): StartupShellSnapshot | null {
  const overrideSnapshot = readStartupShellSnapshotOverride();
  if (overrideSnapshot) {
    return overrideSnapshot;
  }

  if (shouldIgnoreStoredStartupShellSnapshot()) {
    return null;
  }

  return readPersistedStartupShellSnapshotFromStorage(storage).snapshot;
}

export function readPersistedStartupShellSnapshot(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): StartupShellSnapshot | null {
  return readPersistedStartupShellSnapshotFromStorage(storage).snapshot;
}

export function primeStartupShellSnapshot(params?: {
  readFallbackSnapshot?: () => StartupShellSnapshot | null;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}): StartupShellSnapshot | null {
  const storage = params?.storage ?? window.localStorage;
  const overrideSnapshot = readStartupShellSnapshotOverride();
  if (overrideSnapshot) {
    saveStartupShellSnapshot(overrideSnapshot, storage);
    return overrideSnapshot;
  }

  if (shouldIgnoreStoredStartupShellSnapshot()) {
    saveStartupShellSnapshot(null, storage);
    return null;
  }

  const persistedSnapshot = readPersistedStartupShellSnapshotFromStorage(storage);
  if (persistedSnapshot.snapshot) {
    if (persistedSnapshot.needsMigration) {
      saveStartupShellSnapshot(persistedSnapshot.snapshot, storage);
    }

    return persistedSnapshot.snapshot;
  }

  const fallbackSnapshot = restoreStartupShellSnapshot(params?.readFallbackSnapshot?.() ?? null);
  if (!hasStartupShellSnapshot(fallbackSnapshot)) {
    return null;
  }

  saveStartupShellSnapshot(fallbackSnapshot, storage);
  return fallbackSnapshot;
}

export function saveStartupShellSnapshot(
  snapshot: StartupShellSnapshot | null,
  storage: Pick<Storage, "setItem" | "removeItem"> = window.localStorage,
) {
  try {
    if (!snapshot || !hasStartupShellSnapshot(snapshot)) {
      storage.removeItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
      return;
    }

    const storedSnapshot: Record<string, StartupShellSnapshotStoredItem> = {
      [STARTUP_SHELL_SNAPSHOT_STORAGE_ROW_KEY]: {
        versionKey: createStartupShellSnapshotVersionKey(),
        data: toStartupShellSnapshotStorageRow(snapshot),
      },
    };
    storage.setItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY, JSON.stringify(storedSnapshot));
  } catch {
    // Ignore storage failures and keep live UI responsive.
  }
}
