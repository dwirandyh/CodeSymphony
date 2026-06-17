import os from "node:os";
import path from "node:path";
import { mkdir, readdir, rm, stat } from "node:fs/promises";

const APP_ICON_CACHE_DIR = path.join(os.tmpdir(), "codesymphony-app-icons");

export type RuntimeCacheClearResult = {
  cleared: true;
  clearedPaths: string[];
};

function resolveDefaultCodesymphonyCacheRoot(): string {
  return path.join(os.homedir(), ".codesymphony", "cache");
}

function usesDefaultCacheLayout(): boolean {
  return !process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR?.trim()
    && !process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR?.trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function clearDirectoryContents(directoryPath: string): Promise<void> {
  if (!(await pathExists(directoryPath))) {
    return;
  }

  const entries = await readdir(directoryPath);
  await Promise.all(entries.map((entry) => rm(path.join(directoryPath, entry), {
    recursive: true,
    force: true,
  })));
}

async function resetConfiguredCacheDirectory(envKey: string): Promise<string | null> {
  const configured = process.env[envKey]?.trim();
  if (!configured) {
    return null;
  }

  const resolved = path.resolve(configured);
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export type RuntimeCacheClearHooks = {
  clearInMemoryCaches?: () => void | Promise<void>;
};

export async function clearAllRuntimeCaches(
  hooks: RuntimeCacheClearHooks = {},
): Promise<RuntimeCacheClearResult> {
  const clearedPaths: string[] = [];

  if (usesDefaultCacheLayout()) {
    const cacheRoot = resolveDefaultCodesymphonyCacheRoot();
    if (await pathExists(cacheRoot)) {
      await clearDirectoryContents(cacheRoot);
      clearedPaths.push(cacheRoot);
    }
  }

  const modelCatalogDir = await resetConfiguredCacheDirectory("CODESYMPHONY_MODEL_CATALOG_CACHE_DIR");
  if (modelCatalogDir && !clearedPaths.includes(modelCatalogDir)) {
    clearedPaths.push(modelCatalogDir);
  }

  const slashCommandDir = await resetConfiguredCacheDirectory("CODESYMPHONY_SLASH_COMMAND_CACHE_DIR");
  if (slashCommandDir && !clearedPaths.includes(slashCommandDir)) {
    clearedPaths.push(slashCommandDir);
  }

  if (await pathExists(APP_ICON_CACHE_DIR)) {
    await rm(APP_ICON_CACHE_DIR, { recursive: true, force: true });
    clearedPaths.push(APP_ICON_CACHE_DIR);
  }

  await hooks.clearInMemoryCaches?.();

  return {
    cleared: true,
    clearedPaths,
  };
}