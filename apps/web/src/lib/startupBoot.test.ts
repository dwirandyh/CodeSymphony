import { beforeEach, describe, expect, it, vi } from "vitest";

const primeStartupShellSnapshotMock = vi.fn();
const initializeWorkspacePersistenceMock = vi.fn();
const startWorkspaceStartupBootstrapMock = vi.fn();

describe("startupBoot", () => {
  beforeEach(() => {
    vi.resetModules();
    primeStartupShellSnapshotMock.mockReset();
    initializeWorkspacePersistenceMock.mockReset();
    startWorkspaceStartupBootstrapMock.mockReset();
    initializeWorkspacePersistenceMock.mockResolvedValue(undefined);
    startWorkspaceStartupBootstrapMock.mockResolvedValue(null);
  });

  it("primes local startup snapshot immediately, waits for persistence init, then boots workspace data", async () => {
    const { bootstrapWorkspaceStartup } = await import("./startupBoot");

    await bootstrapWorkspaceStartup({ id: "query-client" } as never, {
      primeStartupShellSnapshot: primeStartupShellSnapshotMock,
      initializeWorkspacePersistence: initializeWorkspacePersistenceMock,
      startWorkspaceStartupBootstrap: startWorkspaceStartupBootstrapMock,
    });

    expect(primeStartupShellSnapshotMock).toHaveBeenCalledTimes(1);
    expect(primeStartupShellSnapshotMock).toHaveBeenCalledWith();
    expect(initializeWorkspacePersistenceMock).toHaveBeenCalledTimes(1);
    expect(startWorkspaceStartupBootstrapMock).toHaveBeenCalledWith({ id: "query-client" });
    expect(initializeWorkspacePersistenceMock.mock.invocationCallOrder[0]).toBeLessThan(
      startWorkspaceStartupBootstrapMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(primeStartupShellSnapshotMock.mock.invocationCallOrder[0]).toBeLessThan(
      startWorkspaceStartupBootstrapMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("still boots workspace data when persistence init fails", async () => {
    initializeWorkspacePersistenceMock.mockRejectedValueOnce(new Error("sqlite unavailable"));
    const { bootstrapWorkspaceStartup } = await import("./startupBoot");

    await expect(bootstrapWorkspaceStartup({ id: "query-client" } as never, {
      primeStartupShellSnapshot: primeStartupShellSnapshotMock,
      initializeWorkspacePersistence: initializeWorkspacePersistenceMock,
      startWorkspaceStartupBootstrap: startWorkspaceStartupBootstrapMock,
    })).resolves.toBeUndefined();

    expect(primeStartupShellSnapshotMock).toHaveBeenCalledTimes(1);
    expect(startWorkspaceStartupBootstrapMock).toHaveBeenCalledWith({ id: "query-client" });
  });
});
