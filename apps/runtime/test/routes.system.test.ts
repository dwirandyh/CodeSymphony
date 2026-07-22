import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cursorSessionRunner from "../src/cursor/sessionRunner.js";
import { registerModelRoutes } from "../src/routes/models";
import { registerSystemRoutes } from "../src/routes/system";

describe("system routes", () => {
  let app: FastifyInstance;
  const pickDirectory = vi.fn();
  const readClipboard = vi.fn();
  const writeClipboard = vi.fn();
  const getInstalledApps = vi.fn();
  const openInApp = vi.fn();

  const mockModelProviderService = {
    listProviders: vi.fn().mockResolvedValue([]),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    createModel: vi.fn(),
    deleteModel: vi.fn(),
    resolveProviderSelection: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorate("systemService", { pickDirectory, readClipboard, writeClipboard, getInstalledApps, openInApp } as never);
    app.decorate("modelProviderService", mockModelProviderService as never);
    await app.register(registerModelRoutes, { prefix: "/api" });
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

  it("POST /api/system/cache/clear forces model catalogs to reload", async () => {
    await app.close();

    const modelCatalogCacheDir = await mkdtemp(path.join(os.tmpdir(), "codesymphony-model-catalog-cache-"));
    process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR = modelCatalogCacheDir;

    app = Fastify({ logger: false });
    app.decorate("systemService", { pickDirectory, readClipboard, writeClipboard, getInstalledApps, openInApp } as never);
    app.decorate("modelProviderService", mockModelProviderService as never);
    await app.register(registerModelRoutes, { prefix: "/api" });
    await app.register(registerSystemRoutes, { prefix: "/api" });
    await app.ready();

    const listCursorModels = vi.spyOn(cursorSessionRunner, "listCursorModels")
      .mockResolvedValue([{ id: "composer-2.5", name: "Composer 2.5 Fast" }]);

    const first = await app.inject({ method: "GET", url: "/api/cursor/models" });
    expect(first.statusCode).toBe(200);
    expect(listCursorModels).toHaveBeenCalledTimes(1);

    const clear = await app.inject({ method: "POST", url: "/api/system/cache/clear" });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().data.cleared).toBe(true);
    expect(clear.json().data.clearedPaths.length).toBeGreaterThan(0);

    listCursorModels.mockResolvedValue([{ id: "composer-2.5", name: "Composer 2.5" }]);

    const second = await app.inject({ method: "GET", url: "/api/cursor/models" });
    expect(second.statusCode).toBe(200);
    expect(listCursorModels).toHaveBeenCalledTimes(2);
    expect(second.json().data.models[0]?.name).toBe("Composer 2.5");

    delete process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR;
    await rm(modelCatalogCacheDir, { recursive: true, force: true });
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
    getInstalledApps.mockResolvedValue([{ id: "cursor", name: "Cursor", path: "/Applications/Cursor.app" }]);
    openInApp.mockResolvedValue(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/api/system/open-in-app",
      payload: { appId: "cursor", targetPath: "/home/project" },
    });
    expect(res.statusCode).toBe(204);
    expect(openInApp).toHaveBeenCalledWith("/Applications/Cursor.app", "/home/project");
  });

  it("POST /api/system/open-in-app opens Finder from installed apps list", async () => {
    getInstalledApps.mockResolvedValue([{ id: "finder", name: "Finder", path: "/System/Library/CoreServices/Finder.app" }]);
    openInApp.mockResolvedValue(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/api/system/open-in-app",
      payload: { appId: "finder", targetPath: "/home/project" },
    });
    expect(res.statusCode).toBe(204);
    expect(getInstalledApps).toHaveBeenCalledTimes(1);
    expect(openInApp).toHaveBeenCalledWith("/System/Library/CoreServices/Finder.app", "/home/project");
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
