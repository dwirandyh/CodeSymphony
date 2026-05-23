import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  SlashCommandCatalogSchema,
  type CliAgent,
  type SlashCommandCatalog,
} from "@codesymphony/shared-types";
import { createPersistentExpiringCache } from "../persistentExpiringCache.js";
import { resolveSlashCommandCatalogCacheVersion } from "./slashCommandCatalogVersion.js";

const SLASH_COMMAND_CATALOG_CACHE_TTL_MS = 60 * 60_000;

type SlashCommandCatalogLoaderParams = {
  worktreeId: string;
  worktreePath: string;
  agent: CliAgent;
};

function resolveSlashCommandCatalogCacheDir(): string {
  const configuredDir = process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR?.trim();
  if (configuredDir) {
    return path.resolve(configuredDir);
  }

  return path.join(os.homedir(), ".codesymphony", "cache", "slash-commands");
}

function resolveSlashCommandCatalogCachePath(worktreePath: string, agent: CliAgent): string {
  const worktreeHash = createHash("sha1")
    .update(worktreePath)
    .digest("hex");
  return path.join(resolveSlashCommandCatalogCacheDir(), agent, `${worktreeHash}.json`);
}

export function createSlashCommandCatalogCacheManager(params: {
  load: (params: SlashCommandCatalogLoaderParams) => Promise<SlashCommandCatalog>;
}) {
  const caches = new Map<string, ReturnType<typeof createPersistentExpiringCache<SlashCommandCatalog>>>();

  function getCache(input: SlashCommandCatalogLoaderParams) {
    const cacheKey = `${input.agent}\u0000${input.worktreePath}`;
    const existing = caches.get(cacheKey);
    if (existing) {
      return existing;
    }

    const next = createPersistentExpiringCache({
      ttlMs: SLASH_COMMAND_CATALOG_CACHE_TTL_MS,
      storagePath: resolveSlashCommandCatalogCachePath(input.worktreePath, input.agent),
      load: async () => params.load(input),
      validate: (candidate) => SlashCommandCatalogSchema.parse(candidate),
    });
    caches.set(cacheKey, next);
    return next;
  }

  return {
    async get(input: SlashCommandCatalogLoaderParams): Promise<SlashCommandCatalog> {
      const cache = getCache(input);
      const snapshot = await cache.get({
        cacheVersion: resolveSlashCommandCatalogCacheVersion(input.worktreePath, input.agent),
      });
      return snapshot.value;
    },
  };
}
