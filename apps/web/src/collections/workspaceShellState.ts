import { createCollection } from "@tanstack/db";
import {
  readPersistedStartupShellSnapshot,
  saveStartupShellSnapshot,
  WORKSPACE_SHELL_STATE_ROW_ID,
  type StartupShellSnapshot,
} from "../lib/startupShellSnapshot";
import { withWorkspaceCollectionPersistence } from "../lib/workspacePersistence";

const WORKSPACE_SHELL_STATE_COLLECTION_ID = "workspace-shell-state";

type WorkspaceShellStateRow = StartupShellSnapshot & {
  id: typeof WORKSPACE_SHELL_STATE_ROW_ID;
};

function toWorkspaceShellStateRow(snapshot: StartupShellSnapshot): WorkspaceShellStateRow {
  return {
    id: WORKSPACE_SHELL_STATE_ROW_ID,
    ...snapshot,
  };
}

function createWorkspaceShellStateCollection() {
  const persistedSnapshot = readPersistedStartupShellSnapshot();

  return createCollection(
    withWorkspaceCollectionPersistence({
      id: WORKSPACE_SHELL_STATE_COLLECTION_ID,
      getKey: (row: WorkspaceShellStateRow) => row.id,
      initialData: persistedSnapshot ? [toWorkspaceShellStateRow(persistedSnapshot)] : [],
    }, {
      schemaVersion: 1,
    }),
  );
}

type WorkspaceShellStateCollection = ReturnType<typeof createWorkspaceShellStateCollection>;

let workspaceShellStateCollection: WorkspaceShellStateCollection | null = null;

export function getWorkspaceShellStateCollection(): WorkspaceShellStateCollection {
  if (workspaceShellStateCollection) {
    return workspaceShellStateCollection;
  }

  workspaceShellStateCollection = createWorkspaceShellStateCollection();
  return workspaceShellStateCollection;
}

function getWorkspaceShellStateRows(collection: WorkspaceShellStateCollection): WorkspaceShellStateRow[] {
  return collection.toArray as unknown as WorkspaceShellStateRow[];
}

function snapshotWithoutVolatileFields(snapshot: StartupShellSnapshot | WorkspaceShellStateRow): Omit<StartupShellSnapshot, "capturedAt"> {
  return {
    version: snapshot.version,
    repoId: snapshot.repoId,
    repoName: snapshot.repoName,
    worktreeId: snapshot.worktreeId,
    worktreeBranch: snapshot.worktreeBranch,
    worktreePath: snapshot.worktreePath,
    worktreeStatus: snapshot.worktreeStatus,
    threadId: snapshot.threadId,
    threadTitle: snapshot.threadTitle,
    threadStatus: snapshot.threadStatus,
    ...(snapshot.repositories ? { repositories: snapshot.repositories } : {}),
    ...(snapshot.hiddenRepositoryIds ? { hiddenRepositoryIds: snapshot.hiddenRepositoryIds } : {}),
    ...(snapshot.expandedRepositoryIds ? { expandedRepositoryIds: snapshot.expandedRepositoryIds } : {}),
  };
}

function workspaceShellSnapshotsMatch(
  existing: WorkspaceShellStateRow,
  next: StartupShellSnapshot,
): boolean {
  return JSON.stringify(snapshotWithoutVolatileFields(existing)) === JSON.stringify(snapshotWithoutVolatileFields(next));
}

export function readWorkspaceShellStateSnapshot(): StartupShellSnapshot | null {
  return readPersistedStartupShellSnapshot();
}

export function writeWorkspaceShellStateSnapshot(snapshot: StartupShellSnapshot | null) {
  const collection = getWorkspaceShellStateCollection();
  const existing = getWorkspaceShellStateRows(collection)[0];

  if (!snapshot) {
    if (existing) {
      collection.delete(existing.id);
    }
    saveStartupShellSnapshot(null);
    return;
  }

  const nextRow = toWorkspaceShellStateRow(snapshot);

  if (!existing) {
    collection.insert(nextRow);
    saveStartupShellSnapshot(snapshot);
    return;
  }

  if (workspaceShellSnapshotsMatch(existing, snapshot)) {
    return;
  }

  collection.update(existing.id, (draft) => {
    Object.assign(draft, nextRow);
  });
  saveStartupShellSnapshot(snapshot);
}

export async function resetWorkspaceShellStateCollectionForTest() {
  if (!workspaceShellStateCollection) {
    return;
  }

  await Promise.resolve(workspaceShellStateCollection.cleanup());
  workspaceShellStateCollection = null;
}
