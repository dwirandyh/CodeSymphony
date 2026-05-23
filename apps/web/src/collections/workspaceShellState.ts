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
