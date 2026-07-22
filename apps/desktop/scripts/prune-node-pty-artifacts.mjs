import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Strip Windows-only node-pty artifacts from a macOS runtime bundle.
 *
 * node-pty ships prebuilds for every platform plus debug .pdb files. On a
 * macOS arm64/x64 app only `prebuilds/<platform>-<arch>` is loaded
 * (see node-pty/lib/utils.js). Win32 prebuilds, .pdb symbols, winpty sources,
 * and conpty third_party are dead weight.
 *
 * @param {string} bundleDir Absolute path to the runtime-bundle root.
 * @param {{ platform?: string, arch?: string }} [options]
 * @returns {{ removed: string[] }}
 */
export function pruneNodePtyArtifacts(bundleDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const removed = [];
  const nodePtyDir = join(bundleDir, "node_modules", "node-pty");

  if (!existsSync(nodePtyDir)) {
    return { removed };
  }

  const keepPrebuild = `${platform}-${arch}`;
  const prebuildsDir = join(nodePtyDir, "prebuilds");

  if (existsSync(prebuildsDir)) {
    let entries = [];
    try {
      entries = readdirSync(prebuildsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === keepPrebuild) continue;
      rmSync(join(prebuildsDir, entry.name), { recursive: true, force: true });
      removed.push(`prebuilds/${entry.name}`);
    }
  }

  // Drop debug symbols anywhere under node-pty (win32 .pdb files).
  const pdbStack = [nodePtyDir];
  while (pdbStack.length > 0) {
    const dir = pdbStack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pdbStack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".pdb")) {
        rmSync(full, { force: true });
        removed.push(full.slice(nodePtyDir.length + 1));
      }
    }
  }

  // Windows-only build inputs not needed at macOS runtime.
  if (platform === "darwin" || platform === "linux") {
    for (const rel of ["deps/winpty", "third_party/conpty", "src", "scripts", "binding.gyp"]) {
      const target = join(nodePtyDir, rel);
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(rel);
    }

    // *.test.js under lib/ is never loaded at runtime.
    const libDir = join(nodePtyDir, "lib");
    if (existsSync(libDir)) {
      const walk = [libDir];
      while (walk.length > 0) {
        const dir = walk.pop();
        let entries = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk.push(full);
            continue;
          }
          if (entry.isFile() && entry.name.endsWith(".test.js")) {
            rmSync(full, { force: true });
            removed.push(full.slice(nodePtyDir.length + 1));
          }
        }
      }
    }
  }

  return { removed };
}

function isExecutedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return (
      entry === thisFile ||
      entry.endsWith("/prune-node-pty-artifacts.mjs") ||
      pathToFileURL(entry).href === import.meta.url
    );
  } catch {
    return entry.endsWith("prune-node-pty-artifacts.mjs");
  }
}

if (isExecutedAsCli()) {
  const bundleDir = process.argv[2];
  if (!bundleDir) {
    console.error("Usage: bun prune-node-pty-artifacts.mjs <bundleDir>");
    process.exit(1);
  }
  const { removed } = pruneNodePtyArtifacts(bundleDir);
  if (removed.length === 0) {
    console.log("No node-pty artifacts to prune.");
  } else {
    console.log(`Pruned node-pty artifacts (${removed.length}):`);
    for (const name of removed) console.log(`  - ${name}`);
  }
}
