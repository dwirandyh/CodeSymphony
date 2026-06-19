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

  it("omits thinking param when reasoningEffort is none and catalog has no none value", () => {
    expect(resolveCursorSdkModelSelection({
      model: "gpt-5.5[reasoning=medium]",
      modelOptions: [{ id: "reasoningEffort", value: "none" }],
      catalog,
    })).toEqual({ id: "gpt-5.5" });
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

  it("maps reasoningEffort to SDK reasoning param when catalog uses reasoning id (gpt-5.5)", () => {
    const gptCatalog = [
      {
        id: "gpt-5.5",
        parameters: [
          {
            id: "reasoning",
            values: [
              { value: "none" },
              { value: "low" },
              { value: "medium" },
              { value: "high" },
            ],
          },
          {
            id: "fast",
            values: [{ value: "true" }, { value: "false" }],
          },
        ],
      },
    ];

    expect(resolveCursorSdkModelSelection({
      model: "gpt-5.5",
      modelOptions: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: false },
      ],
      catalog: gptCatalog,
    })).toEqual({
      id: "gpt-5.5",
      params: [
        { id: "fast", value: "false" },
        { id: "reasoning", value: "low" },
      ],
    });
  });

  it("maps reasoningEffort none to SDK reasoning=none when catalog supports none", () => {
    const gptCatalog = [
      {
        id: "gpt-5.5",
        parameters: [
          {
            id: "reasoning",
            values: [
              { value: "none" },
              { value: "low" },
              { value: "medium" },
              { value: "high" },
            ],
          },
        ],
      },
    ];

    expect(resolveCursorSdkModelSelection({
      model: "gpt-5.5",
      modelOptions: [{ id: "reasoningEffort", value: "none" }],
      catalog: gptCatalog,
    })).toEqual({
      id: "gpt-5.5",
      params: [{ id: "reasoning", value: "none" }],
    });
  });

  it("maps fastMode toggle to SDK fast param for non-composer models when catalog supports it", () => {
    const catalogWithFast = [
      ...catalog,
      {
        id: "claude-opus-4-8",
        parameters: [
          { id: "fast", values: [{ value: "true" }, { value: "false" }] },
        ],
      },
    ];

    expect(resolveCursorSdkModelSelection({
      model: "claude-opus-4-8",
      modelOptions: [{ id: "fastMode", value: true }],
      catalog: catalogWithFast,
    })).toEqual({
      id: "claude-opus-4-8",
      params: [{ id: "fast", value: "true" }],
    });
  });
});
