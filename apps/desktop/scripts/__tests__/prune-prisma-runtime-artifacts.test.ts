import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prunePrismaRuntimeArtifacts } from "../prune-prisma-runtime-artifacts.mjs";

const tempDirs: string[] = [];

function makePrismaFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cs-prisma-bundle-"));
  tempDirs.push(root);
  const runtimeDir = join(root, "node_modules", "@prisma", "client", "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  const files = [
    "library.js",
    "client.js",
    "query_engine_bg.sqlite.js",
    "query_engine_bg.sqlite.wasm-base64.js",
    "query_engine_bg.mysql.js",
    "query_engine_bg.mysql.wasm-base64.js",
    "query_engine_bg.postgresql.wasm-base64.mjs",
    "query_compiler_bg.sqlserver.js",
    "query_compiler_bg.cockroachdb.wasm-base64.js",
    "query_compiler_bg.sqlite.mjs",
  ];
  for (const name of files) writeFileSync(join(runtimeDir, name), "x");

  const generated = join(root, "node_modules", ".prisma", "client");
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, "index.js"), "x");
  writeFileSync(join(generated, "libquery_engine-darwin-arm64.dylib.node"), "engine");
  writeFileSync(join(generated, "libquery_engine-darwin.dylib.node"), "engine-x64");

  for (const pkg of [
    ["@prisma", "engines"],
    ["prisma"],
    ["@prisma", "fetch-engine"],
    ["@prisma", "get-platform"],
  ]) {
    const dir = join(root, "node_modules", ...pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
  }

  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("prunePrismaRuntimeArtifacts", () => {
  it("removes non-sqlite engines and keep-host dylib only", () => {
    const bundleDir = makePrismaFixture();
    const result = prunePrismaRuntimeArtifacts(bundleDir, { engineSuffix: "darwin-arm64" });

    expect(result.removed).toEqual(
      expect.arrayContaining([
        "@prisma/client/runtime/query_engine_bg.mysql.js",
        "@prisma/client/runtime/query_engine_bg.mysql.wasm-base64.js",
        "@prisma/client/runtime/query_engine_bg.postgresql.wasm-base64.mjs",
        "@prisma/client/runtime/query_compiler_bg.sqlserver.js",
        "@prisma/client/runtime/query_compiler_bg.cockroachdb.wasm-base64.js",
        ".prisma/client/libquery_engine-darwin.dylib.node",
        "@prisma/engines",
        "prisma",
        "@prisma/fetch-engine",
      ]),
    );

    // Kept
    expect(existsSync(join(bundleDir, "node_modules/@prisma/client/runtime/library.js"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/@prisma/client/runtime/query_engine_bg.sqlite.js"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/@prisma/client/runtime/query_compiler_bg.sqlite.mjs"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/.prisma/client/libquery_engine-darwin-arm64.dylib.node"))).toBe(true);
    expect(existsSync(join(bundleDir, "node_modules/.prisma/client/index.js"))).toBe(true);
    // get-platform is a tiny runtime dep of client — keep
    expect(existsSync(join(bundleDir, "node_modules/@prisma/get-platform/package.json"))).toBe(true);

    // Removed
    expect(existsSync(join(bundleDir, "node_modules/@prisma/client/runtime/query_engine_bg.mysql.js"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/.prisma/client/libquery_engine-darwin.dylib.node"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/@prisma/engines"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/prisma"))).toBe(false);
    expect(existsSync(join(bundleDir, "node_modules/@prisma/fetch-engine"))).toBe(false);
  });

  it("is a no-op when node_modules is missing", () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "cs-prisma-empty-"));
    tempDirs.push(bundleDir);
    expect(prunePrismaRuntimeArtifacts(bundleDir).removed).toEqual([]);
  });
});
