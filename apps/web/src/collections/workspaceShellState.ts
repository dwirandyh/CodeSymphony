import { createCollection } from "@tanstack/db";
import {
  restoreStartupShellSnapshot,
  type StartupShellSnapshot,
} from "../lib/startupShellSnapshot";
import { withWorkspaceCollectionPersistence } from "../lib/workspacePersistence";

const WORKSPACE_SHELL_STATE_COLLECTION_ID = "workspace-shell-state";
const WORKSPACE_SHELL_STATE_ROW_ID = "workspace-shell";

type WorkspaceShellStateRow = StartupShellSnapshot & {
  id: typeof WORKSPACE_SHELL_STATE_ROW_ID;
};

function toWorkspaceShellStateRow(snapshot: StartupShellSnapshot): WorkspaceShellStateRow {
  return {
    id: WORKSPACE_SHELL_STATE_ROW_ID,
    ...snapshot,
  };
}

function toStartupShellSnapshot(row: WorkspaceShellStateRow | null | undefined): StartupShellSnapshot | null {
  return restoreStartupShellSnapshot(row);
}

function createWorkspaceShellStateCollection() {
  return createCollection(
    withWorkspaceCollectionPersistence(
      {
        id: WORKSPACE_SHELL_STATE_COLLECTION_ID,
        getKey: (row: WorkspaceShellStateRow) => row.id,
      },
      { schemaVersion: 1 },
    ),
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
  const collection = getWorkspaceShellStateCollection();
  const row = getWorkspaceShellStateRows(collection)[0];
  const snapshot = toStartupShellSnapshot(row);

  if (!snapshot && row) {
    collection.delete(row.id);
  }

  return snapshot;
}

export function writeWorkspaceShellStateSnapshot(snapshot: StartupShellSnapshot | null) {
  const collection = getWorkspaceShellStateCollection();
  const existing = getWorkspaceShellStateRows(collection)[0];

  if (!snapshot) {
    if (existing) {
      collection.delete(existing.id);
    }
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
