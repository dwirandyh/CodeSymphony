import { describe, expect, it } from "vitest";
import { __testing, buildCodexCliProviderHint } from "../src/codex/config";

describe("codex config helpers", () => {
  it("parses the active global Codex provider override from config.toml", () => {
    const parsed = __testing.parseCodexTomlConfig([
      "# ProxyPal - Codex Configuration",
      "model_provider = \"cliproxyapi\"",
      "model = \"gpt-5.4\"",
      "",
      "[model_providers.cliproxyapi]",
      "name = \"cliproxyapi\"",
      "base_url = \"http://127.0.0.1:8317/v1\"",
      "wire_api = \"responses\"",
      "",
    ].join("\n"));

    expect(parsed.globals.get("model_provider")).toBe("cliproxyapi");
    expect(parsed.globals.get("model")).toBe("gpt-5.4");
    expect(parsed.sections.get("model_providers.cliproxyapi")?.get("base_url")).toBe("http://127.0.0.1:8317/v1");
  });

  it("keeps inline hashes inside quoted strings when building provider hints", () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codesymphony-config-does-not-exist";

    try {
      expect(__testing.stripInlineComment("base_url = \"http://127.0.0.1:8317/v1#frag\" # comment"))
        .toBe("base_url = \"http://127.0.0.1:8317/v1#frag\"");
      expect(buildCodexCliProviderHint()).toBeNull();
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });
});
