import { beforeEach, describe, expect, it, vi } from "vitest";

const { listRuns, cancelRun, getRun } = vi.hoisted(() => ({
  listRuns: vi.fn(),
  cancelRun: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    listRuns,
    cancelRun,
    getRun,
  },
}));

import {
  reconcileStaleCursorSdkRunsBeforeSend,
} from "../src/cursor/sdk/staleRunRecovery.js";

describe("Cursor SDK stale run recovery", () => {
  beforeEach(() => {
    listRuns.mockReset();
    cancelRun.mockReset();
    getRun.mockReset();
  });

  it("cancels and waits on non-terminal runs before a new send", async () => {
    listRuns.mockResolvedValue({
      items: [
        { id: "run-finished", status: "finished" },
        { id: "run-stale", status: "running" },
      ],
    });
    const wait = vi.fn().mockResolvedValue({ status: "cancelled" });
    getRun.mockResolvedValue({ wait });

    await reconcileStaleCursorSdkRunsBeforeSend({
      agentId: "agent-1",
      cwd: "/tmp/project",
    });

    expect(listRuns).toHaveBeenCalledWith("agent-1", { runtime: "local", cwd: "/tmp/project" });
    expect(cancelRun).toHaveBeenCalledWith("run-stale", { runtime: "local", cwd: "/tmp/project" });
    expect(getRun).toHaveBeenCalledWith("run-stale", { runtime: "local", cwd: "/tmp/project" });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("no-ops when every run is already terminal", async () => {
    listRuns.mockResolvedValue({
      items: [
        { id: "run-finished", status: "finished" },
        { id: "run-cancelled", status: "cancelled" },
      ],
    });

    await reconcileStaleCursorSdkRunsBeforeSend({
      agentId: "agent-1",
      cwd: "/tmp/project",
    });

    expect(cancelRun).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
  });
});