import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearAllRuntimeCaches } from "../src/services/runtimeCacheService.js";

describe("clearAllRuntimeCaches", () => {
  let tempDir: string;

  afterEach(async () => {
    delete process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR;
    delete process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("clears persisted files under the codesymphony cache root", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codesymphony-cache-root-"));
    const cacheRoot = path.join(tempDir, "cache");
    const modelCatalogDir = path.join(cacheRoot, "model-catalogs");
    const slashDir = path.join(cacheRoot, "slash-commands", "claude");
    process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR = modelCatalogDir;
    process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR = path.join(cacheRoot, "slash-commands");

    await mkdir(modelCatalogDir, { recursive: true });
    await mkdir(slashDir, { recursive: true });
    await writeFile(path.join(modelCatalogDir, "cursor.json"), "{}", "utf8");
    await writeFile(path.join(slashDir, "abc.json"), "{}", "utf8");

    const result = await clearAllRuntimeCaches();

    expect(result.cleared).toBe(true);
    expect(result.clearedPaths).toContain(modelCatalogDir);
    expect(await readdir(modelCatalogDir)).toEqual([]);
    expect(await readdir(path.join(cacheRoot, "slash-commands"))).toEqual([]);
  });
});