import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, readFileMock, readdirMock, rmMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  readFileMock: vi.fn(),
  readdirMock: vi.fn(),
  rmMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
  readdir: readdirMock,
  rm: rmMock,
}));

import { removeGitWorktree } from "../src/services/git";

describe("removeGitWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmMock.mockResolvedValue(undefined);
  });

  it("repairs broken gitdir metadata and retries removal", async () => {
    execFileMock
      .mockRejectedValueOnce(new Error("git -C /repo worktree remove --force /worktree failed: fatal: validation failed"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await removeGitWorktree({ repositoryPath: "/repo", worktreePath: "/worktree" });

    expect(execFileMock).toHaveBeenNthCalledWith(1, "git", ["-C", "/repo", "worktree", "remove", "--force", "/worktree"], expect.any(Object));
    expect(execFileMock).toHaveBeenNthCalledWith(2, "git", ["-C", "/repo", "worktree", "repair", "/worktree"], expect.any(Object));
    expect(execFileMock).toHaveBeenNthCalledWith(3, "git", ["-C", "/repo", "worktree", "remove", "--force", "/worktree"], expect.any(Object));
  });

  it("falls back to pruning broken admin dirs when repair cannot fix the worktree", async () => {
    execFileMock
      .mockRejectedValueOnce(new Error("git remove failed: fatal: validation failed, cannot remove working tree: '/worktree' does not point back to '.git/worktrees/name1'"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("git remove failed: fatal: validation failed, cannot remove working tree: '/worktree' does not point back to '.git/worktrees/name1'"))
      .mockResolvedValueOnce({ stdout: ".git\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === "/worktree/.git") {
        return "gitdir: /repo/.git/worktrees/wrong-name\n";
      }
      if (filePath === "/repo/.git/worktrees/name1/gitdir") {
        return "/worktree/.git\n";
      }
      throw new Error(`Unexpected readFile path: ${filePath}`);
    });

    readdirMock.mockResolvedValueOnce([
      { name: "name1", isDirectory: () => true },
      { name: "not-a-dir", isDirectory: () => false },
    ]);

    await removeGitWorktree({ repositoryPath: "/repo", worktreePath: "/worktree" });

    expect(rmMock).toHaveBeenCalledWith("/repo/.git/worktrees/wrong-name", { recursive: true, force: true });
    expect(rmMock).toHaveBeenCalledWith("/repo/.git/worktrees/name1", { recursive: true, force: true });
    expect(execFileMock).toHaveBeenLastCalledWith("git", ["-C", "/repo", "worktree", "prune"], expect.any(Object));
  });
});
