import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneNodePtyArtifacts } from "../prune-node-pty-artifacts.mjs";

const tempDirs: string[] = [];

function makeNodePtyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cs-node-pty-bundle-"));
  tempDirs.push(root);
  const pty = join(root, "node_modules", "node-pty");
  for (const pre of ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"]) {
    const dir = join(pty, "prebuilds", pre);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pty.node"), "bin");
    if (pre.startsWith("win32")) {
      writeFileSync(join(dir, "pty.pdb"), "debug");
      writeFileSync(join(dir, "conpty.pdb"), "debug");
    }
  }
  mkdirSync(join(pty, "deps", "winpty"), { recursive: true });
  writeFileSync(join(pty, "deps", "winpty", "winpty.cc"), "src");
  mkdirSync(join(pty, "third_party", "conpty"), { recursive: true });
  writeFileSync(join(pty, "third_party", "conpty", "conpty.dll"), "dll");
  mkdirSync(join(pty, "src", "unix"), { recursive: true });
  writeFileSync(join(pty, "src", "unix", "pty.cc"), "cc");
  mkdirSync(join(pty, "lib"), { recursive: true });
  writeFileSync(join(pty, "lib", "index.js"), "module.exports = {}");
  writeFileSync(join(pty, "lib", "unixTerminal.js"), "module.exports = {}");
  writeFileSync(join(pty, "lib", "unixTerminal.test.js"), "test");
  writeFileSync(join(pty, "binding.gyp"), "{}");
  mkdirSync(join(pty, "scripts"), { recursive: true });
  writeFileSync(join(pty, "scripts", "publish.js"), "x");
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("pruneNodePtyArtifacts", () => {
  it("keeps only the host prebuild and drops win32/pdb/win-only sources on darwin-arm64", () => {
    const bundleDir = makeNodePtyFixture();
    const result = pruneNodePtyArtifacts(bundleDir, { platform: "darwin", arch: "arm64" });

    expect(result.removed).toEqual(
      expect.arrayContaining([
        "prebuilds/darwin-x64",
        "prebuilds/win32-x64",
        "prebuilds/win32-arm64",
        "deps/winpty",
        "third_party/conpty",
        "src",
        "scripts",
        "binding.gyp",
        "lib/unixTerminal.test.js",
      ]),
    );

    expect(existsSync(join(bundleDir, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/node-pty/prebuilds/win32-x64"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/node-pty/prebuilds/darwin-x64"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/node-pty/deps/winpty"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/node-pty/lib/index.js"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/node-pty/lib/unixTerminal.js"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/node-pty/lib/unixTerminal.test.js"))).toBe(false);
  });

  it("is a no-op when node-pty is missing", () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "cs-node-pty-empty-"));
    tempDirs.push(bundleDir);
    expect(pruneNodePtyArtifacts(bundleDir).removed).toEqual([]);
  });
});
