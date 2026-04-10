import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScripts } from "../src/services/scriptRunner";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cs-script-runner-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("runScripts", () => {
  it("runs successful command", async () => {
    const result = await runScripts(["echo hello"], tempDir, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("runs multiple commands in sequence", async () => {
    const result = await runScripts(["echo first", "echo second"], tempDir, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("first");
    expect(result.output).toContain("second");
  });

  it("preserves shell state across commands", async () => {
    const result = await runScripts(["export MY_VAR=hello", "echo $MY_VAR"], tempDir, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("stops on first failure", async () => {
    const result = await runScripts(["echo ok", "exit 1", "echo never"], tempDir, {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("ok");
    expect(result.output).not.toContain("never");
  });

  it("passes custom env variables", async () => {
    const result = await runScripts(["echo $MY_VAR"], tempDir, { MY_VAR: "custom_value" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("custom_value");
  });

  it("handles empty commands array", async () => {
    const result = await runScripts([], tempDir, {});
    expect(result.success).toBe(true);
    expect(result.output).toBe("");
  });
});
