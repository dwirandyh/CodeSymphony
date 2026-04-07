import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const execFilePromisifiedMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: Object.assign(execFileMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: execFilePromisifiedMock,
  }),
}));

import { listGitlabMergeRequests } from "../src/services/git";

describe("git review CLI integration", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFilePromisifiedMock.mockReset();
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
});
