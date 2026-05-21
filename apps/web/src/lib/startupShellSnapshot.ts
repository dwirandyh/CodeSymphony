export const STARTUP_SHELL_SNAPSHOT_VERSION = 1;
export const STARTUP_SHELL_SNAPSHOT_STORAGE_KEY = "codesymphony:workspace:startup-shell:v1";

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

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
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
    )
  );
}

export function resolveStartupWorkspaceSelection(params: {
  repoId?: string;
  worktreeId?: string;
  threadId?: string;
  snapshot: StartupShellSnapshot | null;
}) {
  return {
    repoId: params.repoId ?? params.snapshot?.repoId ?? undefined,
    worktreeId: params.worktreeId ?? params.snapshot?.worktreeId ?? undefined,
    threadId: params.threadId ?? params.snapshot?.threadId ?? undefined,
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

  try {
    const raw = storage.getItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<StartupShellSnapshot> | null;
    return restoreStartupShellSnapshot(parsed);
  } catch {
    return null;
  }
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

  const existingSnapshot = loadStartupShellSnapshot(storage);
  if (existingSnapshot) {
    return existingSnapshot;
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

    storage.setItem(STARTUP_SHELL_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures and keep live UI responsive.
  }
}
