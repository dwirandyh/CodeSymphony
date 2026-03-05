import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFilesystemService } from "../src/services/filesystemService";

let tempDir: string;
const service = createFilesystemService();

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cs-fs-service-"));
  await mkdir(join(tempDir, "project-a"), { recursive: true });
  await mkdir(join(tempDir, "project-b/.git"), { recursive: true });
  await mkdir(join(tempDir, ".hidden"), { recursive: true });
  await writeFile(join(tempDir, "file.txt"), "text");
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("filesystemService", () => {
  describe("browse", () => {
    it("lists directories in path", async () => {
      const result = await service.browse(tempDir);
      expect(result.currentPath).toBe(tempDir);
      expect(result.parentPath).toBeTruthy();
      const names = result.entries.map((e) => e.name);
      expect(names).toContain("project-a");
      expect(names).toContain("project-b");
    });

    it("detects git repos", async () => {
      const result = await service.browse(tempDir);
      const gitRepo = result.entries.find((e) => e.name === "project-b");
      expect(gitRepo?.isGitRepo).toBe(true);
      const nonGitDir = result.entries.find((e) => e.name === "project-a");
      expect(nonGitDir?.isGitRepo).toBe(false);
    });

    it("sorts hidden directories last", async () => {
      const result = await service.browse(tempDir);
      const hiddenIdx = result.entries.findIndex((e) => e.name === ".hidden");
      const projectIdx = result.entries.findIndex((e) => e.name === "project-a");
      expect(hiddenIdx).toBeGreaterThan(projectIdx);
    });

    it("does not include regular files", async () => {
      const result = await service.browse(tempDir);
      const names = result.entries.map((e) => e.name);
      expect(names).not.toContain("file.txt");
    });

    it("sets parentPath to null for root", async () => {
      const result = await service.browse("/");
      expect(result.parentPath).toBeNull();
    });

    it("throws for nonexistent path", async () => {
      await expect(service.browse("/nonexistent-dir-12345")).rejects.toThrow();
    });
  });
});
