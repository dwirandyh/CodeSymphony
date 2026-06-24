import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import {
  resolveReadLintsSummary,
  shouldSuppressReadLintsOutput,
} from "./readLintsUtils.js";

function makeEvent(idx: number, type: ChatEvent["type"], payload: ChatEvent["payload"]): ChatEvent {
  return {
    id: `event-${idx}`,
    threadId: "thread-1",
    idx,
    type,
    payload,
    createdAt: new Date(0).toISOString(),
  };
}

describe("readLintsUtils", () => {
  it("builds a readable summary from persisted Cursor JSON and toolInput.paths", () => {
    const event = makeEvent(1, "tool.finished", {
      toolName: "readLints",
      summary: "{\"status\":\"success\",\"value\":{\"fileDiagnostics\":[{\"path\":\"/Users/me/termlite/Components/TerminalKeyboardChrome.swift\",\"diagnostics\":[],\"diagnosticsCount\":0}],\"totalFiles\":1,\"totalDiagnostics\":0}}",
      toolInput: {
        paths: ["/Users/me/termlite/Components/TerminalKeyboardChrome.swift"],
      },
    });

    expect(resolveReadLintsSummary(event)).toBe(
      "Checked lints TerminalKeyboardChrome.swift (0 issues)",
    );
  });

  it("suppresses raw JSON output when diagnostics are empty", () => {
    const json = "{\"status\":\"success\",\"value\":{\"fileDiagnostics\":[],\"totalFiles\":1,\"totalDiagnostics\":0}}";
    expect(shouldSuppressReadLintsOutput(json)).toBe(true);
  });

  it("keeps non-json output visible", () => {
    expect(shouldSuppressReadLintsOutput("lint runner unavailable")).toBe(false);
  });
});