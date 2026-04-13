import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const execFilePromisifiedMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: Object.assign(execFileMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: execFilePromisifiedMock,
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

import { ensureCliAvailable, listGithubPullRequests, listGitlabMergeRequests } from "../src/services/git";

describe("git review CLI integration", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFilePromisifiedMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it("uses glab mr list --all for GitLab review lookup", async () => {
    execFilePromisifiedMock.mockResolvedValue({
      stdout: JSON.stringify([
        {
          iid: 42,
          web_url: "https://gitlab.com/acme/repo/-/merge_requests/42",
          source_branch: "feature/demo",
          target_branch: "dev",
          state: "opened",
          updated_at: "2026-04-07T00:00:00Z",
        },
      ]),
      stderr: "",
    });

    const reviews = await listGitlabMergeRequests("/tmp/repo", "dev");

    expect(execFilePromisifiedMock).toHaveBeenCalledWith(
      "glab",
      ["mr", "list", "--all", "--target-branch", "dev", "--output", "json"],
      {
        cwd: "/tmp/repo",
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: undefined,
      },
    );
    expect(reviews).toEqual([
      {
        number: 42,
        url: "https://gitlab.com/acme/repo/-/merge_requests/42",
        headBranch: "feature/demo",
        baseBranch: "dev",
        state: "open",
        updatedAt: "2026-04-07T00:00:00Z",
      },
    ]);
  });

  it("falls back to the Homebrew gh binary when PATH lookup fails", async () => {
    const enoentError = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    existsSyncMock.mockImplementation((candidate: string) => candidate === "/opt/homebrew/bin/gh");
    execFilePromisifiedMock
      .mockRejectedValueOnce(enoentError)
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 17,
            url: "https://github.com/acme/repo/pull/17",
            headRefName: "feature/demo",
            baseRefName: "main",
            state: "OPEN",
            updatedAt: "2026-04-13T00:00:00Z",
          },
        ]),
        stderr: "",
      });

    const reviews = await listGithubPullRequests("/tmp/repo", "main");

    expect(execFilePromisifiedMock).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["pr", "list", "--state", "all", "--base", "main", "--json", "number,url,headRefName,baseRefName,state,updatedAt"],
      {
        cwd: "/tmp/repo",
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: undefined,
      },
    );
    expect(execFilePromisifiedMock).toHaveBeenNthCalledWith(
      2,
      "/opt/homebrew/bin/gh",
      ["pr", "list", "--state", "all", "--base", "main", "--json", "number,url,headRefName,baseRefName,state,updatedAt"],
      {
        cwd: "/tmp/repo",
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: undefined,
      },
    );
    expect(reviews).toEqual([
      {
        number: 17,
        url: "https://github.com/acme/repo/pull/17",
        headBranch: "feature/demo",
        baseBranch: "main",
        state: "open",
        updatedAt: "2026-04-13T00:00:00Z",
      },
    ]);
  });

  it("falls back to the Homebrew glab binary for availability checks", async () => {
    const enoentError = Object.assign(new Error("spawn glab ENOENT"), { code: "ENOENT" });
    existsSyncMock.mockImplementation((candidate: string) => candidate === "/opt/homebrew/bin/glab");
    execFilePromisifiedMock
      .mockRejectedValueOnce(enoentError)
      .mockResolvedValueOnce({ stdout: "glab version 1.0.0", stderr: "" });

    await expect(ensureCliAvailable("glab")).resolves.toBeUndefined();

    expect(execFilePromisifiedMock).toHaveBeenNthCalledWith(
      1,
      "glab",
      ["--version"],
      {
        cwd: undefined,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 10 * 1024 * 1024,
        env: undefined,
      },
    );
    expect(execFilePromisifiedMock).toHaveBeenNthCalledWith(
      2,
      "/opt/homebrew/bin/glab",
      ["--version"],
      {
        cwd: undefined,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 10 * 1024 * 1024,
        env: undefined,
      },
    );
  });
});
