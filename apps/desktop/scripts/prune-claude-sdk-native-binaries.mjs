import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Remove Claude Agent SDK platform-native CLI packages from a runtime bundle.
 *
 * CodeSymphony always passes `pathToClaudeCodeExecutable` to the SDK and
 * resolves the user's system Claude Code install, so the ~200MB optional
 * native binary shipped by `@anthropic-ai/claude-agent-sdk` is dead weight
 * inside the packaged .app.
 *
 * Keeps `@anthropic-ai/claude-agent-sdk` (the JS wrapper) intact.
 *
 * @param {string} bundleDir Absolute path to the runtime-bundle root.
 * @returns {{ removed: string[] }}
 */
export function pruneClaudeSdkNativeBinaries(bundleDir) {
  const anthropicDir = join(bundleDir, "node_modules", "@anthropic-ai");
  const removed = [];

  if (!existsSync(anthropicDir)) {
    return { removed };
  }

  let entries = [];
  try {
    entries = readdirSync(anthropicDir, { withFileTypes: true });
  } catch {
    return { removed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Match optionalDependencies of @anthropic-ai/claude-agent-sdk:
    //   claude-agent-sdk-darwin-arm64, claude-agent-sdk-linux-x64-musl, etc.
    if (!entry.name.startsWith("claude-agent-sdk-")) continue;

    rmSync(join(anthropicDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }

  return { removed };
}

function isExecutedAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;

  try {
    const thisFile = fileURLToPath(import.meta.url);
    // Compare resolved paths; bun may pass absolute or relative argv[1].
    return (
      entry === thisFile ||
      entry.endsWith("/prune-claude-sdk-native-binaries.mjs") ||
      pathToFileURL(entry).href === import.meta.url
    );
  } catch {
    return entry.endsWith("prune-claude-sdk-native-binaries.mjs");
  }
}

if (isExecutedAsCli()) {
  const bundleDir = process.argv[2];
  if (!bundleDir) {
    console.error("Usage: bun prune-claude-sdk-native-binaries.mjs <bundleDir>");
    process.exit(1);
  }

  const { removed } = pruneClaudeSdkNativeBinaries(bundleDir);
  if (removed.length === 0) {
    console.log("No Claude Agent SDK native packages to prune.");
  } else {
    console.log(`Pruned Claude Agent SDK native packages (${removed.length}):`);
    for (const name of removed) {
      console.log(`  - @anthropic-ai/${name}`);
    }
  }
}
