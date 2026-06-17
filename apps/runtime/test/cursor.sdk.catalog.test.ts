import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureFakeCursorSdk,
  FakeCursorSdkModule,
  fakeCursorSdkModelListRequests,
  resetFakeCursorSdkState,
} from "./support/fakeCursorSdk";

describe("Cursor SDK catalog", () => {
  afterEach(() => {
    resetFakeCursorSdkState();
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("lists SDK models and expands variants to normalized bracket ids", async () => {
    vi.doMock("@cursor/sdk", () => FakeCursorSdkModule);
    configureFakeCursorSdk({
      models: [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          variants: [
            {
              displayName: "Fast",
              params: [{ id: "fast", value: "true" }],
            },
            {
              displayName: "Thinking",
              params: [{ id: "fast", value: "false" }],
            },
          ],
        },
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
        },
      ],
    });

    const { listCursorSdkModels } = await import("../src/cursor/sdk/catalog");

    await expect(listCursorSdkModels({ apiKey: "cursor-key" })).resolves.toEqual([
      { id: "composer-2.5", name: "Composer 2.5 Fast" },
      { id: "composer-2.5[fast=false]", name: "Composer 2.5 Thinking" },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ]);
    expect(fakeCursorSdkModelListRequests).toEqual([{ apiKey: "cursor-key" }]);
  });

  it("does not duplicate the base model name when a variant displayName already includes it", async () => {
    vi.doMock("@cursor/sdk", () => FakeCursorSdkModule);
    configureFakeCursorSdk({
      models: [
        {
          id: "claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          variants: [
            {
              displayName: "Claude Sonnet 4.6 [effort=medium][fast]",
              params: [
                { id: "thinking", value: "true" },
                { id: "effort", value: "medium" },
                { id: "fast", value: "true" },
              ],
            },
          ],
        },
      ],
    });

    const { listCursorSdkModels } = await import("../src/cursor/sdk/catalog");

    await expect(listCursorSdkModels({ apiKey: "cursor-key" })).resolves.toEqual([
      {
        id: "claude-sonnet-4-6[thinking=true,effort=medium,fast=true]",
        name: "Claude Sonnet 4.6 [effort=medium][fast]",
      },
    ]);
  });

  it("lists slash commands by scanning Cursor skills", async () => {
    vi.doMock("@cursor/sdk", () => FakeCursorSdkModule);
    const cwd = await mkdtemp(join(tmpdir(), "cursor-sdk-skills-"));
    const skillDir = join(cwd, ".cursor", "skills", "dogfood");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), [
      "---",
      "name: dogfood",
      "description: QA a web app",
      "---",
      "",
      "Body.",
    ].join("\n"));

    const { listCursorSdkSlashCommands } = await import("../src/cursor/sdk/catalog");

    await expect(listCursorSdkSlashCommands({ cwd })).resolves.toEqual([
      { name: "dogfood", description: "QA a web app", argumentHint: "" },
    ]);
  });
});
