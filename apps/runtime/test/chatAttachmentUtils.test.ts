import { describe, expect, it } from "vitest";
import { inferPlanDetectionSource, isPrismaRecordNotFound } from "../src/services/chat/chatAttachmentUtils.js";

describe("isPrismaRecordNotFound", () => {
  it("detects Prisma P2025 record-not-found errors", () => {
    expect(isPrismaRecordNotFound({ code: "P2025" })).toBe(true);
    expect(isPrismaRecordNotFound({ code: "P2002" })).toBe(false);
    expect(isPrismaRecordNotFound(new Error("missing"))).toBe(false);
  });
});

describe("inferPlanDetectionSource", () => {
  it("preserves explicit codex plan items", () => {
    expect(inferPlanDetectionSource(".claude/plans/codex-plan.md", "codex_plan_item")).toBe("codex_plan_item");
  });

  it("preserves explicit claude plan files", () => {
    expect(inferPlanDetectionSource(".claude/plans/plan.md", "claude_plan_file")).toBe("claude_plan_file");
  });

  it("treats OpenCode plan files as canonical plan files", () => {
    expect(inferPlanDetectionSource(".opencode/plans/final-plan.md")).toBe("claude_plan_file");
  });

  it("treats Cursor plan files as canonical plan files", () => {
    expect(inferPlanDetectionSource(".cursor/plans/cursor-plan.md")).toBe("claude_plan_file");
  });

  it("falls back to streaming_fallback for non-plan paths", () => {
    expect(inferPlanDetectionSource("streaming-plan")).toBe("streaming_fallback");
  });
});
