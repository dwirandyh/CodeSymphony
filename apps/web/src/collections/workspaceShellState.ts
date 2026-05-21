import { createCollection, localStorageCollectionOptions } from "@tanstack/db";
import {
  readPersistedStartupShellSnapshot,
  saveStartupShellSnapshot,
  STARTUP_SHELL_SNAPSHOT_STORAGE_KEY,
  WORKSPACE_SHELL_STATE_ROW_ID,
  type StartupShellSnapshot,
} from "../lib/startupShellSnapshot";

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
  return createCollection(
    localStorageCollectionOptions<WorkspaceShellStateRow>({
      id: WORKSPACE_SHELL_STATE_COLLECTION_ID,
      storageKey: STARTUP_SHELL_SNAPSHOT_STORAGE_KEY,
      getKey: (row) => row.id,
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

export function readWorkspaceShellStateSnapshot(): StartupShellSnapshot | null {
  return readPersistedStartupShellSnapshot();
}

export function writeWorkspaceShellStateSnapshot(snapshot: StartupShellSnapshot | null) {
  const collection = getWorkspaceShellStateCollection();
  const existing = getWorkspaceShellStateRows(collection)[0];

  if (!snapshot) {
    if (existing) {
      collection.delete(existing.id);
      return;
    }
    saveStartupShellSnapshot(null);
    return;
  }

  const nextRow = toWorkspaceShellStateRow(snapshot);

  if (!existing) {
    collection.insert(nextRow);
    return;
  }

  collection.update(existing.id, (draft) => {
    Object.assign(draft, nextRow);
  });
}

export async function resetWorkspaceShellStateCollectionForTest() {
  if (!workspaceShellStateCollection) {
    return;
  }

  await Promise.resolve(workspaceShellStateCollection.cleanup());
  workspaceShellStateCollection = null;
}
