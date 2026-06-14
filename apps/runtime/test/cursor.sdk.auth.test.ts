import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCursorSdkProviderConfig,
  resolveCursorApiKey,
  withCursorSdkSetupHint,
} from "../src/cursor/sdk/auth.js";

describe("Cursor SDK auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires CURSOR_API_KEY for SDK transport", () => {
    vi.stubEnv("CURSOR_API_KEY", " ");

    expect(() => resolveCursorApiKey()).toThrow(
      "CURSOR_API_KEY is required for the Cursor SDK",
    );
  });

  it("returns the trimmed Cursor API key", () => {
    vi.stubEnv("CURSOR_API_KEY", " cursor-key ");

    expect(resolveCursorApiKey()).toBe("cursor-key");
  });

  it("adds setup hints to Cursor SDK authentication failures", () => {
    const error = withCursorSdkSetupHint(new Error("authentication failed: unauthorized"));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Cursor SDK authentication failed");
    expect((error as Error).message).toContain("Set `CURSOR_API_KEY`");
  });

  it("rejects custom provider base URLs and API keys with the Cursor parity error", () => {
    expect(() => assertCursorSdkProviderConfig({
      providerApiKey: "provider-key",
      providerBaseUrl: null,
    })).toThrow("Cursor uses the authenticated Cursor account via the Cursor SDK and does not support custom provider base URLs or API keys.");
  });
});
