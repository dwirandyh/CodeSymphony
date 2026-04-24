import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSystemRoutes } from "../src/routes/system";

describe("system routes", () => {
  let app: FastifyInstance;
  const pickDirectory = vi.fn();
  const readClipboard = vi.fn();
  const writeClipboard = vi.fn();
  const getInstalledApps = vi.fn();
  const openInApp = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("systemService", { pickDirectory, readClipboard, writeClipboard, getInstalledApps, openInApp } as never);
    await app.register(registerSystemRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /api/system/pick-directory returns path", async () => {
    pickDirectory.mockResolvedValue({ path: "/home/user/project" });
    const res = await app.inject({ method: "POST", url: "/api/system/pick-directory" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.path).toBe("/home/user/project");
  });

  it("POST /api/system/pick-directory handles error", async () => {
    pickDirectory.mockRejectedValue(new Error("Cancelled"));
    const res = await app.inject({ method: "POST", url: "/api/system/pick-directory" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/system/installed-apps returns apps list", async () => {
    getInstalledApps.mockResolvedValue([{ id: "cursor", name: "Cursor" }]);
    const res = await app.inject({ method: "GET", url: "/api/system/installed-apps" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.apps[0].name).toBe("Cursor");
  });

  it("GET /api/system/installed-apps handles error", async () => {
    getInstalledApps.mockRejectedValue(new Error("fail"));
    const res = await app.inject({ method: "GET", url: "/api/system/installed-apps" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/system/clipboard returns host clipboard text", async () => {
    readClipboard.mockResolvedValue("hello from host");
    const res = await app.inject({ method: "GET", url: "/api/system/clipboard" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.text).toBe("hello from host");
  });

  it("PUT /api/system/clipboard writes host clipboard text", async () => {
    writeClipboard.mockResolvedValue(undefined);
    const res = await app.inject({
      method: "PUT",
      url: "/api/system/clipboard",
      payload: { text: "send to host" },
    });
    expect(res.statusCode).toBe(204);
    expect(writeClipboard).toHaveBeenCalledWith("send to host");
  });

  it("POST /api/system/open-in-app opens file", async () => {
    getInstalledApps.mockResolvedValue([{ id: "cursor", name: "Cursor" }]);
    openInApp.mockResolvedValue(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/api/system/open-in-app",
      payload: { appId: "cursor", targetPath: "/home/project" },
    });
    expect(res.statusCode).toBe(204);
    expect(openInApp).toHaveBeenCalledWith("Cursor", "/home/project");
  });

  it("POST /api/system/open-in-app opens Finder from installed apps list", async () => {
    getInstalledApps.mockResolvedValue([{ id: "finder", name: "Finder" }]);
    openInApp.mockResolvedValue(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/api/system/open-in-app",
      payload: { appId: "finder", targetPath: "/home/project" },
    });
    expect(res.statusCode).toBe(204);
    expect(getInstalledApps).toHaveBeenCalledTimes(1);
    expect(openInApp).toHaveBeenCalledWith("Finder", "/home/project");
  });

  it("POST /api/system/open-in-app returns 404 for unknown app", async () => {
    getInstalledApps.mockResolvedValue([]);
    const res = await app.inject({
      method: "POST",
      url: "/api/system/open-in-app",
      payload: { appId: "unknown", targetPath: "/home" },
    });
    expect(res.statusCode).toBe(404);
  });
});
