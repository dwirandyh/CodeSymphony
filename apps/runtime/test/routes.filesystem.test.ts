import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFilesystemRoutes } from "../src/routes/filesystem";

describe("filesystem routes", () => {
  let app: FastifyInstance;
  const browse = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("filesystemService", { browse } as never);
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
});
