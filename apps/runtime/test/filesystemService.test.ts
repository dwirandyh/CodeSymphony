import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFilesystemService } from "../src/services/filesystemService";

let tempDir: string;
const terminalDropTempDirs = new Set<string>();
const service = createFilesystemService();

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cs-fs-service-"));
  await mkdir(join(tempDir, "project-a"), { recursive: true });
  await mkdir(join(tempDir, "project-b/.git"), { recursive: true });
  await mkdir(join(tempDir, ".hidden"), { recursive: true });
  await writeFile(join(tempDir, "file.txt"), "text");
  await writeFile(join(tempDir, "image.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(tempDir, "big.bin"), new Uint8Array(11 * 1024 * 1024));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
  await Promise.all(Array.from(terminalDropTempDirs, (dir) => rm(dir, { recursive: true, force: true })));
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

  describe("readAttachments", () => {
    it("reads text attachments as utf-8 text", async () => {
      const [attachment] = await service.readAttachments([join(tempDir, "file.txt")]);
      expect(attachment.filename).toBe("file.txt");
      expect(attachment.mimeType).toBe("text/plain");
      expect(attachment.content).toBe("text");
    });

    it("reads image attachments as base64", async () => {
      const [attachment] = await service.readAttachments([join(tempDir, "image.png")]);
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.content).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
    });

    it("skips directories, missing files, and oversized files", async () => {
      const attachments = await service.readAttachments([
        join(tempDir, "project-a"),
        join(tempDir, "missing.txt"),
        join(tempDir, "big.bin"),
      ]);
      expect(attachments).toEqual([]);
    });
  });

  describe("writeTerminalDropFiles", () => {
    it("writes dropped browser files to temp paths", async () => {
      const [written] = await service.writeTerminalDropFiles("wt-1:terminal:abc", [{
        filename: "nested/my image.png",
        mimeType: "image/png",
        contentBase64: Buffer.from("png-data").toString("base64"),
      }]);

      terminalDropTempDirs.add(dirname(written.path));

      expect(written.filename).toBe("my image.png");
      expect(written.mimeType).toBe("image/png");
      expect(written.sizeBytes).toBe(8);
      await expect(readFile(written.path, "utf8")).resolves.toBe("png-data");
    });

    it("rejects dropped files above the size limit", async () => {
      await expect(service.writeTerminalDropFiles("wt-1:terminal:abc", [{
        filename: "big.bin",
        mimeType: "application/octet-stream",
        contentBase64: Buffer.from(new Uint8Array(11 * 1024 * 1024)).toString("base64"),
      }])).rejects.toThrow("exceeds the 10 MB terminal drop limit");
    });

    it("cleans up tracked temp files for a terminal session", async () => {
      const [written] = await service.writeTerminalDropFiles("wt-2:terminal:def", [{
        filename: "note.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("cleanup-me").toString("base64"),
      }]);

      const dropDir = dirname(written.path);
      terminalDropTempDirs.add(dropDir);

      await service.cleanupTerminalDropFiles("wt-2:terminal:def");

      await expect(readFile(written.path, "utf8")).rejects.toThrow();
      terminalDropTempDirs.delete(dropDir);
    });
  });
});
