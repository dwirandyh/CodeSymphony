import { describe, expect, it } from "vitest";
import { mapTerminalAgentEvent } from "../src/services/terminalAgentStatusMap";

describe("mapTerminalAgentEvent", () => {
  describe("claude hook_event_name vocabulary", () => {
    it("maps UserPromptSubmit to running", () => {
      expect(mapTerminalAgentEvent({ eventType: "UserPromptSubmit", agent: "claude" }, "idle")).toBe("running");
    });

    it("maps PostToolUse to running", () => {
      expect(mapTerminalAgentEvent({ eventType: "PostToolUse", agent: "claude" }, "waiting_approval")).toBe("running");
    });

    it("maps PreToolUse to waiting_approval", () => {
      expect(mapTerminalAgentEvent({ eventType: "PreToolUse", agent: "claude" }, "running")).toBe("waiting_approval");
    });

    it("maps PreToolUse with ExitPlanMode tool to review_plan", () => {
      expect(
        mapTerminalAgentEvent({ eventType: "PreToolUse", toolName: "ExitPlanMode", agent: "claude" }, "running"),
      ).toBe("review_plan");
    });

    it("maps Notification to waiting_approval", () => {
      expect(mapTerminalAgentEvent({ eventType: "Notification", agent: "claude" }, "running")).toBe("waiting_approval");
    });

    it("maps Stop to idle", () => {
      expect(mapTerminalAgentEvent({ eventType: "Stop", agent: "claude" }, "running")).toBe("idle");
    });

    it("maps SessionStart to idle", () => {
      expect(mapTerminalAgentEvent({ eventType: "SessionStart", agent: "claude" }, "running")).toBe("idle");
    });

    it("maps SessionEnd to idle", () => {
      expect(mapTerminalAgentEvent({ eventType: "SessionEnd", agent: "claude" }, "running")).toBe("idle");
    });
  });

  describe("opencode canonical vocabulary", () => {
    it("maps Start to running", () => {
      expect(mapTerminalAgentEvent({ eventType: "Start", agent: "opencode" }, "idle")).toBe("running");
    });

    it("maps PermissionRequest to waiting_approval", () => {
      expect(mapTerminalAgentEvent({ eventType: "PermissionRequest", agent: "opencode" }, "running")).toBe(
        "waiting_approval",
      );
    });

    it("maps Stop to idle", () => {
      expect(mapTerminalAgentEvent({ eventType: "Stop", agent: "opencode" }, "running")).toBe("idle");
    });

    it("maps SessionStart / SessionEnd to idle", () => {
      expect(mapTerminalAgentEvent({ eventType: "SessionStart", agent: "opencode" }, "running")).toBe("idle");
      expect(mapTerminalAgentEvent({ eventType: "SessionEnd", agent: "opencode" }, "running")).toBe("idle");
    });
  });

  describe("codex vocabulary", () => {
    it("maps task_started / UserTurn Start to running", () => {
      expect(mapTerminalAgentEvent({ eventType: "task_started", agent: "codex" }, "idle")).toBe("running");
      expect(mapTerminalAgentEvent({ eventType: "Start", agent: "codex" }, "idle")).toBe("running");
    });

    it("maps agent-turn-complete / task_complete to idle", () => {
      expect(mapTerminalAgentEvent({ eventType: "agent-turn-complete", agent: "codex" }, "running")).toBe("idle");
      expect(mapTerminalAgentEvent({ eventType: "task_complete", agent: "codex" }, "running")).toBe("idle");
    });

    it("maps approval requests to waiting_approval", () => {
      expect(mapTerminalAgentEvent({ eventType: "exec_approval_request", agent: "codex" }, "running")).toBe(
        "waiting_approval",
      );
      expect(mapTerminalAgentEvent({ eventType: "apply_patch_approval_request", agent: "codex" }, "running")).toBe(
        "waiting_approval",
      );
    });
  });

  describe("unknown events", () => {
    it("keeps previous status when event is unknown", () => {
      expect(mapTerminalAgentEvent({ eventType: "SomethingWeird", agent: "claude" }, "waiting_approval")).toBe(
        "waiting_approval",
      );
    });

    it("defaults to idle when unknown and no previous status", () => {
      expect(mapTerminalAgentEvent({ eventType: "SomethingWeird", agent: "claude" }, undefined)).toBe("idle");
    });
  });
});
