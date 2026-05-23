import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveSlashCommandCatalogCacheVersion", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("changes when the agent binary version changes", async () => {
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: "codex 1.0.0\n", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "codex 2.0.0\n", stderr: "", error: undefined });

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        spawnSync,
      };
    });

    const {
      clearSlashCommandCatalogVersionCache,
      resolveSlashCommandCatalogCacheVersion,
    } = await import("../src/services/chat/slashCommandCatalogVersion.js");
    tempRoot = mkdtempSync(join(tmpdir(), "slash-command-version-"));

    const firstVersion = resolveSlashCommandCatalogCacheVersion(tempRoot, "codex");
    clearSlashCommandCatalogVersionCache();
    const secondVersion = resolveSlashCommandCatalogCacheVersion(tempRoot, "codex");

    expect(firstVersion).not.toBe(secondVersion);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("changes when a local Claude command file changes", async () => {
    const {
      clearSlashCommandCatalogVersionCache,
      resolveSlashCommandCatalogCacheVersion,
    } = await import("../src/services/chat/slashCommandCatalogVersion.js");
    tempRoot = mkdtempSync(join(tmpdir(), "slash-command-version-"));
    const worktreePath = join(tempRoot, "repo");
    const homePath = join(tempRoot, "home");
    vi.stubEnv("HOME", homePath);

    mkdirSync(join(worktreePath, ".claude", "commands"), { recursive: true });
    const commandFilePath = join(worktreePath, ".claude", "commands", "review.md");
    writeFileSync(
      commandFilePath,
      "---\ndescription: Review the current diff.\n---\n# Review\n",
    );

    clearSlashCommandCatalogVersionCache();
    const firstVersion = resolveSlashCommandCatalogCacheVersion(worktreePath, "claude");

    writeFileSync(
      commandFilePath,
      "---\ndescription: Review the current diff and tests.\n---\n# Review\n",
    );

    clearSlashCommandCatalogVersionCache();
    const secondVersion = resolveSlashCommandCatalogCacheVersion(worktreePath, "claude");

    expect(firstVersion).not.toBe(secondVersion);
  });
});
