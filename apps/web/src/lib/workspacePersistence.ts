import {
  localOnlyCollectionOptions,
  type CollectionConfig,
  type LocalOnlyCollectionConfig,
  type UtilsRecord,
} from "@tanstack/db";
import type { StandardSchemaV1 } from "@standard-schema/spec";

const WORKSPACE_PERSISTENCE_DATABASE_NAME = "codesymphony-workspace.sqlite";
const WORKSPACE_PERSISTENCE_COORDINATOR_NAME = "codesymphony-workspace";
const WORKSPACE_PERSISTENCE_INIT_TIMEOUT_MS = 500;

type WorkspacePersistableCollectionOptions = {
  id?: string;
  getKey: (...args: any[]) => string | number;
  sync?: unknown;
};

type PersistedCollectionOptionsFn = (...args: any[]) => unknown;

type WorkspaceLocalOnlyCollectionOptions<
  TItem extends object = Record<string, unknown>,
  TSchema extends StandardSchemaV1 = never,
  TKey extends string | number = string | number,
> = LocalOnlyCollectionConfig<TItem, TSchema, TKey>;

type WorkspacePersistenceMode = "browser" | "disabled";

type WorkspacePersistenceState = {
  mode: WorkspacePersistenceMode;
  wrap: PersistedCollectionOptionsFn | null;
};

type InitializeWorkspacePersistenceOptions = {
  timeoutMs?: number;
};

let workspacePersistenceState: WorkspacePersistenceState = {
  mode: "disabled",
  wrap: null,
};

let workspacePersistenceInitPromise: Promise<void> | null = null;

function setWorkspacePersistenceState(state: WorkspacePersistenceState) {
  workspacePersistenceState = state;
}

function createDisabledWorkspacePersistenceState(): WorkspacePersistenceState {
  return {
    mode: "disabled",
    wrap: null,
  };
}

function createWorkspaceCollectionOptionsWrapper(params: {
  persistedCollectionOptions: PersistedCollectionOptionsFn;
  persistence: unknown;
}): PersistedCollectionOptionsFn {
  const { persistedCollectionOptions, persistence } = params;

  return (options: WorkspacePersistableCollectionOptions, { schemaVersion }: { schemaVersion: number }) => (
    persistedCollectionOptions({
      ...(options as Record<string, unknown>),
      persistence,
      schemaVersion,
    })
  );
}

export async function initializeWorkspacePersistence(options?: InitializeWorkspacePersistenceOptions) {
  if (workspacePersistenceInitPromise) {
    return await workspacePersistenceInitPromise;
  }

  workspacePersistenceInitPromise = (async () => {
    const timeoutMs = Math.max(0, options?.timeoutMs ?? WORKSPACE_PERSISTENCE_INIT_TIMEOUT_MS);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let didResolve = false;

    const resolveState = (state: WorkspacePersistenceState) => {
      if (didResolve) {
        return;
      }

      didResolve = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      setWorkspacePersistenceState(state);
    };

    const initialize = async () => {
      try {
        const {
          BrowserCollectionCoordinator,
          createBrowserWASQLitePersistence,
          openBrowserWASQLiteOPFSDatabase,
          persistedCollectionOptions,
        } = await import("@tanstack/browser-db-sqlite-persistence");
        const database = await openBrowserWASQLiteOPFSDatabase({
          databaseName: WORKSPACE_PERSISTENCE_DATABASE_NAME,
        });
        const coordinator = new BrowserCollectionCoordinator({
          dbName: WORKSPACE_PERSISTENCE_COORDINATOR_NAME,
        });
        const persistence = createBrowserWASQLitePersistence({
          database,
          coordinator,
        });
        resolveState({
          mode: "browser",
          wrap: createWorkspaceCollectionOptionsWrapper({
            persistedCollectionOptions,
            persistence,
          }),
        });
      } catch {
        resolveState(createDisabledWorkspacePersistenceState());
      }
    };

    const timeout = timeoutMs > 0
      ? new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolveState(createDisabledWorkspacePersistenceState());
          resolve();
        }, timeoutMs);
      })
      : null;

    if (timeout) {
      await Promise.race([initialize(), timeout]);
      return;
    }

    await initialize();
  })();

  return await workspacePersistenceInitPromise;
}

export function withWorkspaceCollectionPersistence<
  TItem extends object,
  TSchema extends StandardSchemaV1 = never,
  TKey extends string | number = string | number,
>(
  options: WorkspaceLocalOnlyCollectionOptions<TItem, TSchema, TKey>,
  params: { schemaVersion: number },
): CollectionConfig<TItem, TKey, TSchema, UtilsRecord> & { id: string };
export function withWorkspaceCollectionPersistence<TOptions extends CollectionConfig<any, any, any, any>>(
  options: TOptions,
  params: { schemaVersion: number },
): TOptions;
export function withWorkspaceCollectionPersistence<TOptions extends WorkspacePersistableCollectionOptions>(
  options: TOptions,
  params: { schemaVersion: number },
): unknown {
  if (workspacePersistenceState.wrap) {
    return workspacePersistenceState.wrap(options, params);
  }

  if (!options.sync) {
    return localOnlyCollectionOptions(options as any);
  }

  return options;
}

export function getWorkspacePersistenceModeForTest() {
  return workspacePersistenceState.mode;
}

export function resetWorkspacePersistenceForTest() {
  workspacePersistenceInitPromise = null;
  setWorkspacePersistenceState(createDisabledWorkspacePersistenceState());
}
