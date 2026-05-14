import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFilesystemRoutes } from "../src/routes/filesystem";

describe("filesystem routes", () => {
  let app: FastifyInstance;
  const browse = vi.fn();
  const readAttachments = vi.fn();
  const writeTerminalDropFiles = vi.fn();
  const cleanupTerminalDropFiles = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("filesystemService", { browse, readAttachments, writeTerminalDropFiles, cleanupTerminalDropFiles } as never);
    await app.register(registerFilesystemRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/filesystem/browse returns directory listing", async () => {
    browse.mockResolvedValue({
      currentPath: "/home",
      parentPath: "/",
      entries: [{ name: "user", type: "directory", isGitRepo: false }],
    });
    const res = await app.inject({ method: "GET", url: "/api/filesystem/browse?path=/home" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.currentPath).toBe("/home");
  });

  it("returns 400 on browse error", async () => {
    browse.mockRejectedValue(new Error("ENOENT"));
    const res = await app.inject({ method: "GET", url: "/api/filesystem/browse?path=/nonexistent" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/filesystem/attachments/read returns local attachments", async () => {
    readAttachments.mockResolvedValue([{
      path: "/tmp/test.txt",
      filename: "test.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      content: "test",
    }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/filesystem/attachments/read",
      payload: { paths: ["/tmp/test.txt"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.attachments).toHaveLength(1);
    expect(readAttachments).toHaveBeenCalledWith(["/tmp/test.txt"]);
  });

  it("returns 400 on attachment read error", async () => {
    readAttachments.mockRejectedValue(new Error("EACCES"));
    const res = await app.inject({
      method: "POST",
      url: "/api/filesystem/attachments/read",
      payload: { paths: ["/tmp/blocked.txt"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/filesystem/terminal-drop/write returns temp file paths", async () => {
    writeTerminalDropFiles.mockResolvedValue([{
      path: "/tmp/cs-terminal-drop/test.png",
      filename: "test.png",
      mimeType: "image/png",
      sizeBytes: 4,
    }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/filesystem/terminal-drop/write",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        sessionId: "wt-1:terminal:abc",
        files: [{
          filename: "test.png",
          mimeType: "image/png",
          contentBase64: "dGVzdA==",
        }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.files).toHaveLength(1);
    expect(writeTerminalDropFiles).toHaveBeenCalledWith("wt-1:terminal:abc", [{
      filename: "test.png",
      mimeType: "image/png",
      contentBase64: "dGVzdA==",
    }]);
  });

  it("returns 400 on terminal drop write error", async () => {
    writeTerminalDropFiles.mockRejectedValue(new Error("too large"));
    const res = await app.inject({
      method: "POST",
      url: "/api/filesystem/terminal-drop/write",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        sessionId: "wt-1:terminal:abc",
        files: [{
          filename: "big.png",
          mimeType: "image/png",
          contentBase64: "Zm9v",
        }],
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
