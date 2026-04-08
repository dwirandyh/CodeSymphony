import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

import { __testing, buildClaudeRuntimeEnv } from "../src/claude/shellEnv";

describe("shellEnv", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    __testing.resetInteractiveShellEnvCache();
  });

  it("parses null-delimited shell env output after the marker", () => {
    const parsed = __testing.parseEnvOutput(`noise${String.fromCharCode(0)}__CODESYMPHONY_SHELL_ENV__\0PATH=/opt/homebrew/bin:/usr/bin\0ANDROID_HOME=/sdk\0`);

    expect(parsed).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      ANDROID_HOME: "/sdk",
    });
  });

  it("dedupes preferred path segments ahead of fallback path segments", () => {
    expect(__testing.mergePathValues("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/opt/homebrew/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("merges login-shell PATH and missing vars into the Claude runtime env", () => {
    mockExecFileSync.mockReturnValue("__CODESYMPHONY_SHELL_ENV__\0PATH=/opt/homebrew/bin:/usr/bin\0ANDROID_HOME=/Users/demo/Library/Android/sdk\0");

    const env = buildClaudeRuntimeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/demo",
      SHELL: "/bin/zsh",
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(env.ANDROID_HOME).toBe("/Users/demo/Library/Android/sdk");
  });

  it("preserves explicit runtime env vars over shell-derived values", () => {
    mockExecFileSync.mockReturnValue("__CODESYMPHONY_SHELL_ENV__\0ANDROID_HOME=/shell/sdk\0");

    const env = buildClaudeRuntimeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/demo",
      SHELL: "/bin/zsh",
      ANDROID_HOME: "/runtime/sdk",
    });

    expect(env.ANDROID_HOME).toBe("/runtime/sdk");
  });

  it("falls back to the original env when shell env probing fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("shell failed");
    });

    const env = buildClaudeRuntimeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/demo",
      SHELL: "/bin/zsh",
    });

    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/demo",
      SHELL: "/bin/zsh",
    });
  });
});
