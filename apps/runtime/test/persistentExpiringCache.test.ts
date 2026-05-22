import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentExpiringCache } from "../src/services/persistentExpiringCache.js";

describe("createPersistentExpiringCache", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reuses cached values while the cache version stays the same and reloads after it changes", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codesymphony-persistent-cache-"));
    const load = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const cache = createPersistentExpiringCache({
      ttlMs: 60_000,
      storagePath: path.join(tempDir, "cache.json"),
      load,
      validate: (candidate) => {
        if (typeof candidate !== "string") {
          throw new Error("Expected string");
        }
        return candidate;
      },
    });

    const first = await cache.get({ cacheVersion: "v1" });
    const second = await cache.get({ cacheVersion: "v1" });
    const third = await cache.get({ cacheVersion: "v2" });

    expect(first.value).toBe("first");
    expect(second.value).toBe("first");
    expect(third.value).toBe("second");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reuses the persisted value across cache instances when the cache version matches", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codesymphony-persistent-cache-"));
    const storagePath = path.join(tempDir, "cache.json");
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("persisted");

    const firstCache = createPersistentExpiringCache({
      ttlMs: 60_000,
      storagePath,
      load,
      validate: (candidate) => {
        if (typeof candidate !== "string") {
          throw new Error("Expected string");
        }
        return candidate;
      },
    });
    await firstCache.get({ cacheVersion: "v1" });

    const secondCache = createPersistentExpiringCache({
      ttlMs: 60_000,
      storagePath,
      load,
      validate: (candidate) => {
        if (typeof candidate !== "string") {
          throw new Error("Expected string");
        }
        return candidate;
      },
    });
    const second = await secondCache.get({ cacheVersion: "v1" });

    expect(second.value).toBe("persisted");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
