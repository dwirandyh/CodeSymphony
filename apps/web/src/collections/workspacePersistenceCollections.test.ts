import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoFixture = [{
  id: "r1",
  name: "repo",
  rootPath: "/repo",
  defaultBranch: "main",
  setupScript: null,
  teardownScript: null,
  runScript: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  worktrees: [{
    id: "wt-1",
    repositoryId: "r1",
    branch: "main",
    path: "/repo",
    baseBranch: "main",
    status: "active",
    branchRenamed: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }],
}];

function createMockCollection() {
  return {
    cleanup: vi.fn(),
    subscribeChanges: vi.fn(() => ({ unsubscribe: vi.fn() })),
    toArray: [],
    utils: {
      refetch: vi.fn(),
      isLoading: false,
      isFetching: false,
      lastError: null,
      isError: false,
      writeUpsert: vi.fn(),
      writeDelete: vi.fn(),
      writeBatch: vi.fn((callback: () => void) => callback()),
      writeUpdate: vi.fn(),
    },
  };
}

describe("workspace-persisted collections", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps repositories collection options with workspace persistence", async () => {
    const createCollection = vi.fn(() => createMockCollection());
    const queryCollectionOptions = vi.fn((options) => options);
    const withWorkspaceCollectionPersistence = vi.fn((options) => ({
      ...options,
      persisted: true,
    }));

    vi.doMock("@tanstack/db", () => ({ createCollection }));
    vi.doMock("@tanstack/query-db-collection", () => ({ queryCollectionOptions }));
    vi.doMock("../lib/workspacePersistence", () => ({ withWorkspaceCollectionPersistence }));

    const { getRepositoriesCollection, resetRepositoriesCollectionRegistryForTest } = await import("./repositories");

    getRepositoriesCollection({} as never);

    expect(withWorkspaceCollectionPersistence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "repositories" }),
      { schemaVersion: 1 },
    );

    await resetRepositoriesCollectionRegistryForTest();
  });

  it("schedules a live repository refetch after seeding startup bootstrap cache", async () => {
    const collection = createMockCollection();
    const createCollection = vi.fn(() => collection);
    const queryCollectionOptions = vi.fn((options) => options);
    const withWorkspaceCollectionPersistence = vi.fn((options) => options);

    vi.doMock("@tanstack/db", () => ({ createCollection }));
    vi.doMock("@tanstack/query-db-collection", () => ({ queryCollectionOptions }));
    vi.doMock("../lib/workspacePersistence", () => ({ withWorkspaceCollectionPersistence }));
    vi.doMock("../lib/api", () => ({
      api: {
        listRepositories: vi.fn(),
      },
    }));
    vi.doMock("../lib/workspaceStartupBootstrap", () => ({
      readWorkspaceStartupBootstrapQueryData: vi.fn(() => repoFixture),
      waitForWorkspaceStartupBootstrap: vi.fn().mockResolvedValue(null),
    }));

    const { getRepositoriesCollection, resetRepositoriesCollectionRegistryForTest } = await import("./repositories");

    getRepositoriesCollection({ getQueryData: vi.fn() } as never);

    const repositoriesOptions = queryCollectionOptions.mock.calls[0]?.[0];
    expect(repositoriesOptions).toBeTruthy();

    const result = await repositoriesOptions.queryFn();
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toEqual(repoFixture);
    expect(collection.utils.refetch).toHaveBeenCalledTimes(1);

    await resetRepositoriesCollectionRegistryForTest();
  });

  it("wraps threads collection options with workspace persistence", async () => {
    const createCollection = vi.fn(() => createMockCollection());
    const queryCollectionOptions = vi.fn((options) => options);
    const withWorkspaceCollectionPersistence = vi.fn((options) => ({
      ...options,
      persisted: true,
    }));

    vi.doMock("@tanstack/db", () => ({ createCollection }));
    vi.doMock("@tanstack/query-db-collection", () => ({ queryCollectionOptions }));
    vi.doMock("../lib/workspacePersistence", () => ({ withWorkspaceCollectionPersistence }));

    const { getThreadsCollection, resetThreadsCollectionRegistryForTest } = await import("./threads");

    getThreadsCollection({} as never, "wt-1");

    expect(withWorkspaceCollectionPersistence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "threads:wt-1" }),
      { schemaVersion: 1 },
    );

    await resetThreadsCollectionRegistryForTest();
  });

  it("wraps git status collection options with workspace persistence", async () => {
    const createCollection = vi.fn(() => createMockCollection());
    const queryCollectionOptions = vi.fn((options) => options);
    const withWorkspaceCollectionPersistence = vi.fn((options) => ({
      ...options,
      persisted: true,
    }));

    vi.doMock("@tanstack/db", () => ({ createCollection }));
    vi.doMock("@tanstack/query-db-collection", () => ({ queryCollectionOptions }));
    vi.doMock("../lib/workspacePersistence", () => ({ withWorkspaceCollectionPersistence }));

    const { getGitStatusCollection, resetGitStatusCollectionRegistryForTest } = await import("./gitStatus");

    getGitStatusCollection({} as never, "wt-1");

    expect(withWorkspaceCollectionPersistence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "git-status:wt-1" }),
      { schemaVersion: 1 },
    );

    await resetGitStatusCollectionRegistryForTest();
  });

  it("wraps workspace shell state collection options with workspace persistence", async () => {
    const createCollection = vi.fn(() => ({
      cleanup: vi.fn(),
      delete: vi.fn(),
      insert: vi.fn(),
      subscribeChanges: vi.fn(() => ({ unsubscribe: vi.fn() })),
      toArray: [],
      update: vi.fn(),
    }));
    const withWorkspaceCollectionPersistence = vi.fn((options) => ({
      ...options,
      persisted: true,
    }));

    vi.doMock("@tanstack/db", () => ({ createCollection }));
    vi.doMock("../lib/workspacePersistence", () => ({ withWorkspaceCollectionPersistence }));

    const { getWorkspaceShellStateCollection, resetWorkspaceShellStateCollectionForTest } = await import("./workspaceShellState");

    getWorkspaceShellStateCollection();

    expect(withWorkspaceCollectionPersistence).toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace-shell-state" }),
      { schemaVersion: 1 },
    );

    await resetWorkspaceShellStateCollectionForTest();
  });
});
