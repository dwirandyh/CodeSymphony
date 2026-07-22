import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NON_SQLITE_DB_MARKERS = ["mysql", "postgresql", "sqlserver", "cockroachdb"];

/**
 * Strip Prisma artifacts not needed for a SQLite-only macOS runtime bundle.
 *
 * Keeps:
 *   - @prisma/client JS runtime (library/client/binary entrypoints)
 *   - .prisma/client generated client + the host libquery_engine dylib
 *   - sqlite-named runtime helpers (harmless if present; native engine is used)
 *
 * Removes:
 *   - query_engine_bg / query_compiler_bg for non-sqlite databases
 *   - foreign libquery_engine-*.node binaries
 *   - @prisma/engines + prisma CLI package (generate/migrate not needed at runtime)
 *   - @prisma/fetch-engine (engine already vendored)
 *
 * @param {string} bundleDir
 * @param {{ engineSuffix?: string }} [options]
 *   engineSuffix e.g. "darwin-arm64" or "darwin" — keep only this dylib.
 * @returns {{ removed: string[] }}
 */
export function prunePrismaRuntimeArtifacts(bundleDir, options = {}) {
  const removed = [];
  const nodeModules = join(bundleDir, "node_modules");
  if (!existsSync(nodeModules)) return { removed };

  const engineSuffix = options.engineSuffix ?? defaultEngineSuffix();

  // 1) Drop non-sqlite wasm/engine helpers under @prisma/client/runtime
  const clientRuntimeDir = join(nodeModules, "@prisma", "client", "runtime");
  if (existsSync(clientRuntimeDir)) {
    let entries = [];
    try {
      entries = readdirSync(clientRuntimeDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const isQueryArtifact =
        name.startsWith("query_engine_bg.") || name.startsWith("query_compiler_bg.");
      if (!isQueryArtifact) continue;
      if (name.includes("sqlite")) continue;
      if (!NON_SQLITE_DB_MARKERS.some((marker) => name.includes(marker))) continue;
      rmSync(join(clientRuntimeDir, name), { force: true });
      removed.push(`@prisma/client/runtime/${name}`);
    }
  }

  // 2) Keep only the host libquery_engine under .prisma/client
  const generatedClientDir = join(nodeModules, ".prisma", "client");
  if (existsSync(generatedClientDir)) {
    const keepEngine = `libquery_engine-${engineSuffix}.dylib.node`;
    let entries = [];
    try {
      entries = readdirSync(generatedClientDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("libquery_engine-")) continue;
      if (entry.name === keepEngine) continue;
      rmSync(join(generatedClientDir, entry.name), { force: true });
      removed.push(`.prisma/client/${entry.name}`);
    }
  }

  // 3) Drop packages only needed for generate/migrate/download
  for (const rel of [
    "@prisma/engines",
    "prisma",
    "@prisma/fetch-engine",
  ]) {
    const target = join(nodeModules, ...rel.split("/"));
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(rel);
  }

  return { removed };
}

function defaultEngineSuffix() {
  // Mirror bundle-runtime.sh: arm64 -> darwin-arm64, x86_64 -> darwin
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  return `${process.platform}-${process.arch}`;
}

function isExecutedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return (
      entry === thisFile ||
      entry.endsWith("/prune-prisma-runtime-artifacts.mjs") ||
      pathToFileURL(entry).href === import.meta.url
    );
  } catch {
    return entry.endsWith("prune-prisma-runtime-artifacts.mjs");
  }
}

if (isExecutedAsCli()) {
  const bundleDir = process.argv[2];
  const engineSuffix = process.argv[3]; // optional override
  if (!bundleDir) {
    console.error("Usage: bun prune-prisma-runtime-artifacts.mjs <bundleDir> [engineSuffix]");
    process.exit(1);
  }
  const { removed } = prunePrismaRuntimeArtifacts(
    bundleDir,
    engineSuffix ? { engineSuffix } : {},
  );
  if (removed.length === 0) {
    console.log("No Prisma runtime artifacts to prune.");
  } else {
    console.log(`Pruned Prisma runtime artifacts (${removed.length}):`);
    for (const name of removed) console.log(`  - ${name}`);
  }
}
