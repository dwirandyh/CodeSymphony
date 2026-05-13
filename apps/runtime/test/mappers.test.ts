import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapWorktree, mapRepository, mapChatThread, mapChatAttachment, mapChatMessage } from "../src/services/mappers";

describe("mappers", () => {
  const now = new Date("2025-01-01T00:00:00.000Z");

  describe("mapWorktree", () => {
    it("maps DB worktree to API shape", () => {
      const result = mapWorktree({
        id: "w1",
        repositoryId: "r1",
        branch: "main",
        path: "/tmp/wt",
        baseBranch: "main",
        isAutomation: false,
        status: "active",
        branchRenamed: false,
        createdAt: now,
        updatedAt: now,
      });
      expect(result.id).toBe("w1");
      expect(result.repositoryId).toBe("r1");
      expect(result.branch).toBe("main");
      expect(result.path).toBe("/tmp/wt");
      expect(result.status).toBe("active");
      expect(result.branchRenamed).toBe(false);
      expect(result.createdAt).toBe("2025-01-01T00:00:00.000Z");
    });
  });

  describe("mapRepository", () => {
    it("maps DB repository with worktrees", () => {
      const result = mapRepository({
        id: "r1",
        name: "test-repo",
        rootPath: "/tmp/repo",
        defaultBranch: "main",
        setupScript: JSON.stringify(["npm install"]),
        teardownScript: null,
        runScript: null,
        saveAutomation: JSON.stringify({
          enabled: true,
          target: "workspace_terminal",
          filePatterns: ["lib/**/*.dart"],
          actionType: "send_stdin",
          payload: "r",
          debounceMs: 400,
        }),
        createdAt: now,
        updatedAt: now,
        worktrees: [
          {
            id: "w1",
            repositoryId: "r1",
            branch: "main",
            path: "/tmp/wt",
            baseBranch: "main",
            isAutomation: false,
            status: "active",
            branchRenamed: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      expect(result.id).toBe("r1");
      expect(result.name).toBe("test-repo");
      expect(result.setupScript).toEqual(["npm install"]);
      expect(result.saveAutomation).toEqual({
        enabled: true,
        target: "workspace_terminal",
        filePatterns: ["lib/**/*.dart"],
        actionType: "send_stdin",
        payload: "r",
        debounceMs: 400,
      });
      expect(result.teardownScript).toBeNull();
      expect(result.worktrees.length).toBe(1);
      expect(result.worktrees[0].id).toBe("w1");
    });

    it("handles null scripts", () => {
      const result = mapRepository({
        id: "r1",
        name: "test",
        rootPath: "/tmp",
        defaultBranch: "main",
        setupScript: null,
        teardownScript: null,
        runScript: null,
        saveAutomation: null,
        createdAt: now,
        updatedAt: now,
        worktrees: [],
      });
      expect(result.setupScript).toBeNull();
      expect(result.teardownScript).toBeNull();
      expect(result.runScript).toBeNull();
      expect(result.saveAutomation).toBeNull();
    });
  });

  describe("mapChatThread", () => {
    it("maps DB thread to API shape", () => {
      const result = mapChatThread({
        id: "t1",
        worktreeId: "w1",
        title: "Test Thread",
        kind: "default",
        isAutomation: false,
        permissionProfile: "default",
        permissionMode: "default",
        mode: "plan",
        titleEditedManually: false,
        claudeSessionId: null,
        createdAt: now,
        updatedAt: now,
      });
      expect(result.id).toBe("t1");
      expect(result.title).toBe("Test Thread");
      expect(result.permissionMode).toBe("default");
      expect(result.mode).toBe("plan");
      expect(result.active).toBe(false);
    });

    it("sets active flag", () => {
      const result = mapChatThread({
        id: "t1",
        worktreeId: "w1",
        title: "Test",
        kind: "default",
        isAutomation: false,
        permissionProfile: "default",
        permissionMode: "default",
        mode: "default",
        titleEditedManually: false,
        claudeSessionId: null,
        createdAt: now,
        updatedAt: now,
      }, true);
      expect(result.active).toBe(true);
    });
  });

  describe("mapChatAttachment", () => {
    it("maps DB attachment to API shape", () => {
      const result = mapChatAttachment({
        id: "a1",
        messageId: "m1",
        filename: "test.txt",
        mimeType: "text/plain",
        sizeBytes: 100,
        content: "hello",
        storagePath: null,
        source: "file_picker",
        createdAt: now,
      });
      expect(result.id).toBe("a1");
      expect(result.filename).toBe("test.txt");
      expect(result.mimeType).toBe("text/plain");
      expect(result.source).toBe("file_picker");
    });

    it("hydrates image content from storage when database content is empty", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "codesymphony-mappers-"));
      const imagePath = join(tempDir, "diagram.png");
      const imageBytes = Buffer.from([137, 80, 78, 71]);
      writeFileSync(imagePath, imageBytes);

      const result = mapChatAttachment({
        id: "a2",
        messageId: "m1",
        filename: "diagram.png",
        mimeType: "image/png",
        sizeBytes: imageBytes.length,
        content: "",
        storagePath: imagePath,
        source: "drag_drop",
        createdAt: now,
      });

      expect(result.content).toBe(imageBytes.toString("base64"));
      expect(result.storagePath).toBe(imagePath);
    });
  });

  describe("mapChatMessage", () => {
    it("maps DB message with attachments", () => {
      const result = mapChatMessage({
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user",
        content: "Hello",
        createdAt: now,
        attachments: [
          {
            id: "a1",
            messageId: "m1",
            filename: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 10,
            content: "data",
            storagePath: null,
            source: "file_picker",
            createdAt: now,
          },
        ],
      });
      expect(result.id).toBe("m1");
      expect(result.content).toBe("Hello");
      expect(result.attachments.length).toBe(1);
      expect(result.attachments[0].filename).toBe("file.txt");
    });

    it("handles message without attachments", () => {
      const result = mapChatMessage({
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "assistant",
        content: "Hi",
        createdAt: now,
      });
      expect(result.attachments).toEqual([]);
    });
  });
});
