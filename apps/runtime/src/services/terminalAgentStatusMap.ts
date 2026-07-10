import type { TerminalAgentStatus } from "@codesymphony/shared-types";

type AgentKind = "claude" | "codex" | "opencode";

interface RawAgentEvent {
  eventType: string;
  toolName?: string;
  agent: AgentKind;
}

// Raw event names (across all supported CLIs) that mean the agent started or is
// making progress on a turn.
const RUNNING_EVENTS = new Set([
  "UserPromptSubmit",
  "PostToolUse",
  "Start",
  "task_started",
]);

// Raw event names that mean the agent finished its turn / the session ended.
const IDLE_EVENTS = new Set([
  "Stop",
  "SessionStart",
  "SessionEnd",
  "agent-turn-complete",
  "task_complete",
]);

// Raw event names that mean the agent is blocked waiting for the user to approve
// a tool/exec/patch.
const APPROVAL_EVENTS = new Set([
  "PreToolUse",
  "Notification",
  "PermissionRequest",
  "exec_approval_request",
  "apply_patch_approval_request",
  "request_user_input",
]);

/**
 * Collapse a terminal-hosted agent CLI's raw lifecycle event into the shared
 * thread status vocabulary. Pure; unknown events keep the previous status
 * (falling back to "idle") so a stray event never clears a real state.
 */
export function mapTerminalAgentEvent(
  event: RawAgentEvent,
  prev: TerminalAgentStatus | undefined,
): TerminalAgentStatus {
  const { eventType, toolName } = event;

  // PreToolUse for the plan-review tool is a distinct state, not a generic
  // permission prompt.
  if (eventType === "PreToolUse" && toolName === "ExitPlanMode") {
    return "review_plan";
  }

  if (APPROVAL_EVENTS.has(eventType)) {
    return "waiting_approval";
  }

  if (RUNNING_EVENTS.has(eventType)) {
    return "running";
  }

  if (IDLE_EVENTS.has(eventType)) {
    return "idle";
  }

  return prev ?? "idle";
}
