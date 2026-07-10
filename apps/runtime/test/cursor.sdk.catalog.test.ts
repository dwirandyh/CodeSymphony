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

  it("collapses composer fast variants into one catalog row", async () => {
    vi.doMock("@cursor/sdk", () => FakeCursorSdkModule);
    configureFakeCursorSdk({
      models: [
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          variants: [
            {
              displayName: "Composer 2.5",
              params: [{ id: "fast", value: "true" }],
              isDefault: true,
            },
            {
              displayName: "Composer 2.5",
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
      {
        id: "composer-2.5",
        name: "Composer 2.5",
        defaultVariantParams: { fast: "true" },
      },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ]);
    expect(fakeCursorSdkModelListRequests).toEqual([{ apiKey: "cursor-key" }]);
  });

  it("still collapses composer when variant labels differ only by fast param", async () => {
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
      ],
    });

    const { listCursorSdkModels } = await import("../src/cursor/sdk/catalog");

    await expect(listCursorSdkModels({ apiKey: "cursor-key" })).resolves.toEqual([
      {
        id: "composer-2.5",
        name: "Composer 2.5",
        defaultVariantParams: { fast: "true" },
      },
    ]);
  });

  it("collapses reasoning and fast variants into one catalog row per model", async () => {
    vi.doMock("@cursor/sdk", () => FakeCursorSdkModule);
    configureFakeCursorSdk({
      models: [
        {
          id: "claude-opus-4-8",
          displayName: "Opus 4.8",
          variants: [
            {
              displayName: "Opus 4.8",
              params: [
                { id: "reasoning", value: "low" },
                { id: "fast", value: "false" },
              ],
            },
            {
              displayName: "Opus 4.8",
              params: [
                { id: "reasoning", value: "medium" },
                { id: "fast", value: "true" },
              ],
              isDefault: true,
            },
            {
              displayName: "Opus 4.8",
              params: [
                { id: "reasoning", value: "high" },
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
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        defaultVariantParams: { reasoning: "medium", fast: "true" },
      },
    ]);
  });

  it("uses the default variant display name when it differs from the base model name", async () => {
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
              isDefault: true,
            },
            {
              displayName: "Claude Sonnet 4.6",
              params: [
                { id: "effort", value: "low" },
                { id: "fast", value: "false" },
              ],
            },
          ],
        },
      ],
    });

    const { listCursorSdkModels } = await import("../src/cursor/sdk/catalog");

    await expect(listCursorSdkModels({ apiKey: "cursor-key" })).resolves.toEqual([
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 [effort=medium][fast]",
        defaultVariantParams: {
          thinking: "true",
          effort: "medium",
          fast: "true",
        },
      },
    ]);
  });

  it("resolves default variant params from SDK model variants", async () => {
    const { resolveSdkModelDefaultVariantParams } = await import("../src/cursor/sdk/catalog");

    expect(resolveSdkModelDefaultVariantParams({
      id: "composer-2.5",
      displayName: "Composer 2.5",
      variants: [
        {
          displayName: "Thinking",
          params: [{ id: "fast", value: "false" }],
        },
        {
          displayName: "Fast",
          params: [{ id: "fast", value: "true" }],
          isDefault: true,
        },
      ],
    })).toEqual({ fast: "true" });
    expect(resolveSdkModelDefaultVariantParams({
      id: "gpt-5.5",
      displayName: "GPT-5.5",
    })).toBeUndefined();
  });

  it("lists slash commands by scanning Cursor skills", async () => {
    vi.doMock("@cursor/sdk", () => FakeCursorSdkModule);
    const cwd = await mkdtemp(join(tmpdir(), "cursor-sdk-skills-"));
    vi.doMock("node:os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:os")>();
      return {
        ...actual,
        homedir: () => cwd,
      };
    });
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
