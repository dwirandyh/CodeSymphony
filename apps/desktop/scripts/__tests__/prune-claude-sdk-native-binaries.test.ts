import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneClaudeSdkNativeBinaries } from "../prune-claude-sdk-native-binaries.mjs";

const tempDirs: string[] = [];

function makeBundleFixture(nativePackages: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "cs-runtime-bundle-"));
  tempDirs.push(root);

  const anthropicDir = join(root, "node_modules", "@anthropic-ai");
  mkdirSync(anthropicDir, { recursive: true });

  // Always keep the JS SDK package itself.
  const sdkDir = join(anthropicDir, "claude-agent-sdk");
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(sdkDir, "sdk.mjs"), "export {};\n");
  writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk" }));

  for (const name of nativePackages) {
    const dir = join(anthropicDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), "fake-binary\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@anthropic-ai/${name}` }));
  }

  // Unrelated package must survive.
  const otherDir = join(root, "node_modules", "fastify");
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, "package.json"), JSON.stringify({ name: "fastify" }));

  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("pruneClaudeSdkNativeBinaries", () => {
  it("removes platform native Claude Agent SDK packages from the bundle", () => {
    const bundleDir = makeBundleFixture([
      "claude-agent-sdk-darwin-arm64",
      "claude-agent-sdk-darwin-x64",
      "claude-agent-sdk-linux-x64",
      "claude-agent-sdk-win32-x64",
    ]);

    const result = pruneClaudeSdkNativeBinaries(bundleDir);

    expect(result.removed).toEqual(
      expect.arrayContaining([
        "claude-agent-sdk-darwin-arm64",
        "claude-agent-sdk-darwin-x64",
        "claude-agent-sdk-linux-x64",
        "claude-agent-sdk-win32-x64",
      ]),
    );
    expect(result.removed).toHaveLength(4);

    expect(existsSync(join(bundleDir, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64"))).toBe(false);

    // JS SDK wrapper + unrelated deps stay.
    expect(existsSync(join(bundleDir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/fastify/package.json"))).toBe(true);
  });

  it("is a no-op when no native packages are present", () => {
    const bundleDir = makeBundleFixture([]);

    const result = pruneClaudeSdkNativeBinaries(bundleDir);

    expect(result.removed).toEqual([]);
    expect(existsSync(join(bundleDir, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"))).toBe(true);
  });

  it("is a no-op when node_modules is missing", () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "cs-runtime-bundle-empty-"));
    tempDirs.push(bundleDir);

    const result = pruneClaudeSdkNativeBinaries(bundleDir);

    expect(result.removed).toEqual([]);
  });
});
