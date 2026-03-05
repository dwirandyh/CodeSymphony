import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileService } from "../src/services/fileService";

let repoDir: string;
const fileService = createFileService();

function git(args: string) {
  execSync(`git ${args}`, { cwd: repoDir, encoding: "utf8", stdio: "pipe" });
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "cs-file-service-"));
  git("init --initial-branch=main");
  git('config user.email "test@test.com"');
  git('config user.name "Test"');
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "src/components"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), "# Hello");
  await writeFile(join(repoDir, "src/index.ts"), "export {}");
  await writeFile(join(repoDir, "src/app.ts"), "export {}");
  await writeFile(join(repoDir, "src/components/Button.tsx"), "export {}");
  git("add -A");
  git('commit -m "init"');
});

afterAll(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("fileService", () => {
  describe("searchFiles", () => {
    it("returns matching files by query", async () => {
      const results = await fileService.searchFiles(repoDir, "index");
      expect(results.some(r => r.path.includes("index.ts"))).toBe(true);
    });

    it("returns directories and files when query is empty", async () => {
      const results = await fileService.searchFiles(repoDir, "");
      expect(results.length).toBeGreaterThan(0);
    });

    it("limits results", async () => {
      const results = await fileService.searchFiles(repoDir, "", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("scores exact basename match highest", async () => {
      const results = await fileService.searchFiles(repoDir, "README.md");
      expect(results[0].path).toBe("README.md");
    });

    it("returns empty for non-matching query", async () => {
      const results = await fileService.searchFiles(repoDir, "zzzznonexistent");
      expect(results).toEqual([]);
    });

    it("matches directories too", async () => {
      const results = await fileService.searchFiles(repoDir, "src");
      expect(results.some(r => r.type === "directory" && r.path === "src")).toBe(true);
    });
  });

  describe("listFileIndex", () => {
    it("returns all files and directories", async () => {
      const results = await fileService.listFileIndex(repoDir);
      expect(results.some(r => r.path === "README.md" && r.type === "file")).toBe(true);
      expect(results.some(r => r.path === "src" && r.type === "directory")).toBe(true);
    });
  });

  describe("invalidateCache", () => {
    it("does not throw", () => {
      expect(() => fileService.invalidateCache(repoDir)).not.toThrow();
    });
  });
});
