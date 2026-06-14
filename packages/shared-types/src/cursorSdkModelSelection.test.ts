import { describe, expect, it } from "vitest";
import { resolveCursorSdkModelSelection } from "./cursorSdkModelSelection.js";

const catalog = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [
      {
        id: "fast",
        values: [
          { value: "true" },
          { value: "false" },
        ],
      },
    ],
    variants: [
      {
        displayName: "Fast",
        params: [{ id: "fast", value: "true" }],
      },
      {
        displayName: "Thinking",
        params: [{ id: "fast", value: "false" }],
        isDefault: true,
      },
    ],
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    parameters: [
      {
        id: "thinking",
        values: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
        ],
      },
    ],
  },
];

describe("resolveCursorSdkModelSelection", () => {
  it("maps composer fastMode=false to SDK fast=false param", () => {
    expect(resolveCursorSdkModelSelection({
      model: "composer-2.5[fast=true]",
      modelOptions: [{ id: "fastMode", value: false }],
      catalog,
    })).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
  });

  it("omits fast=true param for composer because bare id is the default fast variant", () => {
    // Cursor SDK rejects explicit fast=true with "Invalid params" because the
    // bare composer id already resolves to the fast variant by default.
    expect(resolveCursorSdkModelSelection({
      model: "composer-2.5",
      modelOptions: [{ id: "fastMode", value: true }],
      catalog,
    })).toEqual({ id: "composer-2.5" });
  });

  it("omits fast=true param when model string carries fast=true metadata", () => {
    expect(resolveCursorSdkModelSelection({
      model: "composer-2.5[fast=true]",
      catalog,
    })).toEqual({ id: "composer-2.5" });
  });

  it("maps reasoningEffort to SDK thinking param when catalog supports it", () => {
    expect(resolveCursorSdkModelSelection({
      model: "gpt-5.5[reasoning=high]",
      modelOptions: [{ id: "reasoningEffort", value: "medium" }],
      catalog,
    })).toEqual({
      id: "gpt-5.5",
      params: [{ id: "thinking", value: "medium" }],
    });
  });

  it("omits unsupported params", () => {
    expect(resolveCursorSdkModelSelection({
      model: "gpt-5.5[fast=true,reasoning=high]",
      modelOptions: [{ id: "fastMode", value: false }],
      catalog,
    })).toEqual({
      id: "gpt-5.5",
      params: [{ id: "thinking", value: "high" }],
    });
  });
});
