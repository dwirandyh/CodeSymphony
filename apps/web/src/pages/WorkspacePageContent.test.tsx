import { describe, expect, it } from "vitest";
import { buildPlanHandoffSearchPatch } from "./workspace/planHandoffNavigation";

describe("buildPlanHandoffSearchPatch", () => {
  it("navigates handoff execution to chat and clears file-specific state", () => {
    expect(buildPlanHandoffSearchPatch("thread-handoff")).toEqual({
      view: undefined,
      file: undefined,
      fileLine: undefined,
      fileColumn: undefined,
      threadId: "thread-handoff",
    });
  });
});
