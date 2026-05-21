import { beforeEach, describe, expect, it, vi } from "vitest";

const primeStartupShellSnapshotMock = vi.fn();
const initializeWorkspacePersistenceMock = vi.fn();
const readWorkspaceShellStateSnapshotMock = vi.fn();
const startWorkspaceStartupBootstrapMock = vi.fn();

describe("startupBoot", () => {
  beforeEach(() => {
    vi.resetModules();
    primeStartupShellSnapshotMock.mockReset();
    initializeWorkspacePersistenceMock.mockReset();
    readWorkspaceShellStateSnapshotMock.mockReset();
    startWorkspaceStartupBootstrapMock.mockReset();
    initializeWorkspacePersistenceMock.mockResolvedValue(undefined);
    startWorkspaceStartupBootstrapMock.mockResolvedValue(null);
  });

  it("primes local startup snapshot immediately, waits for persistence init, then boots workspace data", async () => {
    const { bootstrapWorkspaceStartup } = await import("./startupBoot");

    await bootstrapWorkspaceStartup({ id: "query-client" } as never, {
      primeStartupShellSnapshot: primeStartupShellSnapshotMock,
      initializeWorkspacePersistence: initializeWorkspacePersistenceMock,
      readWorkspaceShellStateSnapshot: readWorkspaceShellStateSnapshotMock,
      startWorkspaceStartupBootstrap: startWorkspaceStartupBootstrapMock,
    });

    expect(primeStartupShellSnapshotMock).toHaveBeenCalledTimes(2);
    expect(primeStartupShellSnapshotMock).toHaveBeenNthCalledWith(1);
    expect(initializeWorkspacePersistenceMock).toHaveBeenCalledTimes(1);
    expect(primeStartupShellSnapshotMock).toHaveBeenNthCalledWith(
      2,
      { readFallbackSnapshot: readWorkspaceShellStateSnapshotMock },
    );
    expect(startWorkspaceStartupBootstrapMock).toHaveBeenCalledWith({ id: "query-client" });
    expect(initializeWorkspacePersistenceMock.mock.invocationCallOrder[0]).toBeLessThan(
      startWorkspaceStartupBootstrapMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(primeStartupShellSnapshotMock.mock.invocationCallOrder[1]).toBeLessThan(
      startWorkspaceStartupBootstrapMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("re-primes from persisted workspace collection after persistence init", async () => {
    const fallbackSnapshot = { version: 1, capturedAt: "2026-05-20T00:00:00.000Z" };
    readWorkspaceShellStateSnapshotMock.mockReturnValue(fallbackSnapshot);
    const { bootstrapWorkspaceStartup } = await import("./startupBoot");

    await bootstrapWorkspaceStartup({} as never, {
      primeStartupShellSnapshot: primeStartupShellSnapshotMock,
      initializeWorkspacePersistence: initializeWorkspacePersistenceMock,
      readWorkspaceShellStateSnapshot: readWorkspaceShellStateSnapshotMock,
      startWorkspaceStartupBootstrap: startWorkspaceStartupBootstrapMock,
    });

    expect(primeStartupShellSnapshotMock).toHaveBeenNthCalledWith(
      2,
      { readFallbackSnapshot: readWorkspaceShellStateSnapshotMock },
    );
  });

  it("still boots workspace data when persistence init fails", async () => {
    initializeWorkspacePersistenceMock.mockRejectedValueOnce(new Error("sqlite unavailable"));
    const { bootstrapWorkspaceStartup } = await import("./startupBoot");

    await expect(bootstrapWorkspaceStartup({ id: "query-client" } as never, {
      primeStartupShellSnapshot: primeStartupShellSnapshotMock,
      initializeWorkspacePersistence: initializeWorkspacePersistenceMock,
      readWorkspaceShellStateSnapshot: readWorkspaceShellStateSnapshotMock,
      startWorkspaceStartupBootstrap: startWorkspaceStartupBootstrapMock,
    })).resolves.toBeUndefined();

    expect(primeStartupShellSnapshotMock).toHaveBeenCalledTimes(2);
    expect(startWorkspaceStartupBootstrapMock).toHaveBeenCalledWith({ id: "query-client" });
  });
});
