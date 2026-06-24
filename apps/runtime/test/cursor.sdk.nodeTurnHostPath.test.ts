import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveNodeTurnHostScript", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("prefers nodeTurnHost.js next to the bundled runtime entry", async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), "codesymphony-runtime-bundle-"));
    const distDir = join(bundleRoot, "dist");
    mkdirSync(distDir, { recursive: true });
    const hostScript = join(distDir, "nodeTurnHost.js");
    writeFileSync(hostScript, "export {};\n");

    const { resolveNodeTurnHostScript } = await import("../src/cursor/sdk/nodeTurnBridge.js");
    const resolved = resolveNodeTurnHostScript(pathToFileURL(join(distDir, "index.js")).href);

    expect(resolved).toBe(hostScript);
  });

  it("falls back to the tsc output path for Bun dev runs", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "codesymphony-runtime-src-"));
    const srcModule = join(workspaceRoot, "src", "cursor", "sdk", "nodeTurnBridge.ts");
    const distHost = join(workspaceRoot, "dist", "cursor", "sdk", "nodeTurnHost.js");
    mkdirSync(dirname(srcModule), { recursive: true });
    mkdirSync(dirname(distHost), { recursive: true });
    writeFileSync(srcModule, "export {};\n");
    writeFileSync(distHost, "export {};\n");

    const { resolveNodeTurnHostScript } = await import("../src/cursor/sdk/nodeTurnBridge.js");
    const resolved = resolveNodeTurnHostScript(pathToFileURL(srcModule).href);

    expect(resolved).toBe(distHost);
  });
});