import { describe, expect, it } from "vitest";
import { parseOpencodeModelCatalog } from "../src/opencode/modelCatalog.js";

describe("parseOpencodeModelCatalog", () => {
  it("parses verbose OpenCode model output into catalog entries", () => {
    const stdout = `opencode/minimax-m2.5-free
{
  "id": "minimax-m2.5-free",
  "providerID": "opencode",
  "name": "MiniMax M2.5 Free"
}
zai/glm-4.7-flash
{
  "id": "glm-4.7-flash",
  "providerID": "zai",
  "name": "GLM-4.7-Flash"
}
`;

    expect(parseOpencodeModelCatalog(stdout)).toEqual([
      {
        id: "opencode/minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        providerId: "opencode",
      },
      {
        id: "zai/glm-4.7-flash",
        name: "GLM-4.7-Flash",
        providerId: "zai",
      },
    ]);
  });

  it("falls back to raw ids when verbose metadata is unavailable", () => {
    const stdout = `opencode/minimax-m2.5-free
zai/glm-4.7-flash
`;

    expect(parseOpencodeModelCatalog(stdout)).toEqual([
      {
        id: "opencode/minimax-m2.5-free",
        name: "opencode/minimax-m2.5-free",
        providerId: "opencode",
      },
      {
        id: "zai/glm-4.7-flash",
        name: "zai/glm-4.7-flash",
        providerId: "zai",
      },
    ]);
  });

  it("ignores non-model noise lines in verbose output", () => {
    const stdout = `npm WARN deprecated left-pad@1.3.0
at Object.<anonymous> (/tmp/index.js:1:1)
opencode/minimax-m2.5-free
{
  "id": "minimax-m2.5-free",
  "providerID": "opencode",
  "name": "MiniMax M2.5 Free"
}
[debug] refreshing provider cache
zai/glm-4.7
{
  "id": "glm-4.7",
  "providerID": "zai",
  "name": "GLM-4.7"
}
`;

    expect(parseOpencodeModelCatalog(stdout)).toEqual([
      {
        id: "opencode/minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        providerId: "opencode",
      },
      {
        id: "zai/glm-4.7",
        name: "GLM-4.7",
        providerId: "zai",
      },
    ]);
  });
});
