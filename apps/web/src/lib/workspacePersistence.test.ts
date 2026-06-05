import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("workspacePersistence", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    delete (window as Window & { __CS_ELECTRON__?: boolean }).__CS_ELECTRON__;
  });

  it("initializes browser sqlite persistence and wraps collection options", async () => {
    const openBrowserWASQLiteOPFSDatabase = vi.fn(async () => "browser-db");
    const BrowserCollectionCoordinator = vi.fn(() => "browser-coordinator");
    const createBrowserWASQLitePersistence = vi.fn(() => "browser-persistence");
    const persistedCollectionOptions = vi.fn((options) => ({
      ...options,
      persisted: "browser",
    }));

    vi.doMock("@tanstack/browser-db-sqlite-persistence", () => ({
      BrowserCollectionCoordinator,
      openBrowserWASQLiteOPFSDatabase,
      createBrowserWASQLitePersistence,
      persistedCollectionOptions,
    }));

    const {
      initializeWorkspacePersistence,
      withWorkspaceCollectionPersistence,
      getWorkspacePersistenceModeForTest,
    } = await import("./workspacePersistence");

    await initializeWorkspacePersistence();

    expect(openBrowserWASQLiteOPFSDatabase).toHaveBeenCalledWith({
      databaseName: "codesymphony-workspace.sqlite",
    });
    expect(createBrowserWASQLitePersistence).toHaveBeenCalledWith({
      database: "browser-db",
      coordinator: expect.any(Object),
    });
    expect(BrowserCollectionCoordinator).toHaveBeenCalledWith({
      dbName: "codesymphony-workspace",
    });
    expect(getWorkspacePersistenceModeForTest()).toBe("browser");

    const wrapped = withWorkspaceCollectionPersistence({
      id: "repositories",
      getKey: (item: { id: string }) => item.id,
      sync: { sync: vi.fn() },
    }, {
      schemaVersion: 1,
    });

    expect(persistedCollectionOptions).toHaveBeenCalledWith(expect.objectContaining({
      id: "repositories",
      persistence: "browser-persistence",
      schemaVersion: 1,
    }));
    expect(wrapped).toMatchObject({
      id: "repositories",
      persisted: "browser",
    });
  });

  it("initializes browser sqlite persistence inside Electron desktop", async () => {
    const openBrowserWASQLiteOPFSDatabase = vi.fn(async () => "electron-browser-db");
    const BrowserCollectionCoordinator = vi.fn(() => "electron-browser-coordinator");
    const createBrowserWASQLitePersistence = vi.fn(() => "electron-browser-persistence");
    const persistedCollectionOptions = vi.fn((options) => ({
      ...options,
      persisted: "electron-browser",
    }));

    (window as Window & { __CS_ELECTRON__?: boolean }).__CS_ELECTRON__ = true;
    vi.doMock("@tanstack/browser-db-sqlite-persistence", () => ({
      BrowserCollectionCoordinator,
      openBrowserWASQLiteOPFSDatabase,
      createBrowserWASQLitePersistence,
      persistedCollectionOptions,
    }));

    const {
      initializeWorkspacePersistence,
      withWorkspaceCollectionPersistence,
      getWorkspacePersistenceModeForTest,
    } = await import("./workspacePersistence");

    await initializeWorkspacePersistence();

    expect(openBrowserWASQLiteOPFSDatabase).toHaveBeenCalledWith({
      databaseName: "codesymphony-workspace.sqlite",
    });
    expect(createBrowserWASQLitePersistence).toHaveBeenCalledWith({
      database: "electron-browser-db",
      coordinator: expect.any(Object),
    });
    expect(BrowserCollectionCoordinator).toHaveBeenCalledWith({
      dbName: "codesymphony-workspace",
    });
    expect(getWorkspacePersistenceModeForTest()).toBe("browser");

    const wrapped = withWorkspaceCollectionPersistence({
      id: "threads:wt-1",
      getKey: (item: { id: string }) => item.id,
      sync: { sync: vi.fn() },
    }, {
      schemaVersion: 2,
    });

    expect(persistedCollectionOptions).toHaveBeenCalledWith(expect.objectContaining({
      id: "threads:wt-1",
      persistence: "electron-browser-persistence",
      schemaVersion: 2,
    }));
    expect(wrapped).toMatchObject({
      id: "threads:wt-1",
      persisted: "electron-browser",
    });

    delete (window as Window & { __CS_ELECTRON__?: boolean }).__CS_ELECTRON__;
  });

  it("falls back to plain collection options when persistence init fails", async () => {
    vi.doMock("@tanstack/browser-db-sqlite-persistence", () => ({
      openBrowserWASQLiteOPFSDatabase: vi.fn(async () => {
        throw new Error("opfs unavailable");
      }),
      createBrowserWASQLitePersistence: vi.fn(),
      persistedCollectionOptions: vi.fn(),
    }));

    const {
      initializeWorkspacePersistence,
      withWorkspaceCollectionPersistence,
      getWorkspacePersistenceModeForTest,
    } = await import("./workspacePersistence");

    await expect(initializeWorkspacePersistence()).resolves.toBeUndefined();
    expect(getWorkspacePersistenceModeForTest()).toBe("disabled");

    const options = {
      id: "git-status:wt-1",
      getKey: (item: { id: string }) => item.id,
      sync: { sync: vi.fn() },
    };

    expect(withWorkspaceCollectionPersistence(options, { schemaVersion: 3 })).toBe(options);
  });

  it("times out browser persistence init and falls back to disabled mode", async () => {
    vi.useFakeTimers();

    vi.doMock("@tanstack/browser-db-sqlite-persistence", () => ({
      openBrowserWASQLiteOPFSDatabase: vi.fn(() => new Promise<never>(() => {})),
      BrowserCollectionCoordinator: vi.fn(),
      createBrowserWASQLitePersistence: vi.fn(),
      persistedCollectionOptions: vi.fn(),
    }));

    const {
      initializeWorkspacePersistence,
      getWorkspacePersistenceModeForTest,
    } = await import("./workspacePersistence");

    const initPromise = initializeWorkspacePersistence({ timeoutMs: 5 });

    await vi.advanceTimersByTimeAsync(5);

    await expect(initPromise).resolves.toBeUndefined();
    expect(getWorkspacePersistenceModeForTest()).toBe("disabled");
  });

  it("wraps local-only collections so createCollection does not throw when persistence is disabled", async () => {
    const { createCollection } = await import("@tanstack/db");
    const { withWorkspaceCollectionPersistence } = await import("./workspacePersistence");

    const collection = createCollection(withWorkspaceCollectionPersistence({
      id: "workspace-shell-state",
      getKey: (row: { id: string }) => row.id,
    }, {
      schemaVersion: 1,
    }));

    collection.insert({ id: "workspace-shell" });

    expect(collection.toArray).toHaveLength(1);
    expect(collection.toArray[0]).toMatchObject({ id: "workspace-shell" });
  });

  it("preserves initialData for local-only collections when persistence is disabled", async () => {
    const { createCollection } = await import("@tanstack/db");
    const { withWorkspaceCollectionPersistence } = await import("./workspacePersistence");

    const collection = createCollection(withWorkspaceCollectionPersistence({
      id: "workspace-shell-state",
      getKey: (row: { id: string }) => row.id,
      initialData: [{ id: "workspace-shell", title: "Restored" }],
    }, {
      schemaVersion: 1,
    }));

    expect(collection.toArray).toHaveLength(1);
    expect(collection.toArray[0]).toMatchObject({ id: "workspace-shell", title: "Restored" });
  });
});
