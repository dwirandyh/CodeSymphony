import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetResolvedAgentConfigCacheForTests,
  setResolvedAgentConfigCacheForTests,
} from "../src/services/agentConfigService";
import { resolveOpencodeBinaryPath } from "../src/opencode/binary";
import { resolveCodexBinaryPath } from "../src/codex/sessionRunner";
import { resolveCursorApiKey } from "../src/cursor/sdk/auth";

const ENV_KEYS = ["OPENCODE_BINARY_PATH", "CODEX_BINARY_PATH", "CURSOR_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetResolvedAgentConfigCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  resetResolvedAgentConfigCacheForTests();
});

describe("resolveOpencodeBinaryPath", () => {
  it("prefers config over env over default", () => {
    expect(resolveOpencodeBinaryPath()).toBe("opencode");

    process.env.OPENCODE_BINARY_PATH = "/env/opencode";
    expect(resolveOpencodeBinaryPath()).toBe("/env/opencode");

    setResolvedAgentConfigCacheForTests({ opencodePath: "/config/opencode" });
    expect(resolveOpencodeBinaryPath()).toBe("/config/opencode");
  });
});

describe("resolveCodexBinaryPath", () => {
  it("prefers config over env over default", () => {
    expect(resolveCodexBinaryPath()).toBe("codex");

    process.env.CODEX_BINARY_PATH = "/env/codex";
    expect(resolveCodexBinaryPath()).toBe("/env/codex");

    setResolvedAgentConfigCacheForTests({ codexPath: "/config/codex" });
    expect(resolveCodexBinaryPath()).toBe("/config/codex");
  });
});

describe("resolveCursorApiKey", () => {
  it("prefers config over env", () => {
    process.env.CURSOR_API_KEY = "env-key";
    expect(resolveCursorApiKey()).toBe("env-key");

    setResolvedAgentConfigCacheForTests({ cursorApiKey: "config-key" });
    expect(resolveCursorApiKey()).toBe("config-key");
  });

  it("throws when neither config nor env provides a key", () => {
    expect(() => resolveCursorApiKey()).toThrow(/CURSOR_API_KEY is required/);
  });
});
