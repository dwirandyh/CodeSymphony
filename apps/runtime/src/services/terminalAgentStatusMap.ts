import type { TerminalAgentStatus } from "@codesymphony/shared-types";

type AgentKind = "claude" | "codex" | "opencode";

interface RawAgentEvent {
  eventType: string;
  toolName?: string;
  /** Claude/Codex permission mode from hook stdin, e.g. "plan" | "default". */
  permissionMode?: string;
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

function isPlanPermissionMode(permissionMode: string | undefined): boolean {
  return (permissionMode ?? "").trim().toLowerCase() === "plan";
}

/** ExitPlanMode (and mild name variants) present the plan for review. */
function isExitPlanTool(toolName: string | undefined): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = toolName.trim().toLowerCase().replace(/[_\s-]/g, "");
  return normalized === "exitplanmode" || normalized.endsWith("exitplanmode");
}

/**
 * Collapse a terminal-hosted agent CLI's raw lifecycle event into the shared
 * thread status vocabulary. Pure; unknown events keep the previous status
 * (falling back to "idle") so a stray event never clears a real state.
 *
 * Plan mode notes:
 * - ExitPlanMode PreToolUse → review_plan (user gate or auto-accept flash).
 * - Notification while permission_mode=plan → review_plan (attention on plan).
 * - Other PreToolUse in plan mode stays running (research tools are not user
 *   tool-gates the way default-mode PreToolUse is).
 * - Auto-execute after plan: ExitPlanMode → review_plan then PostToolUse/tools → running.
 */
export function mapTerminalAgentEvent(
  event: RawAgentEvent,
  prev: TerminalAgentStatus | undefined,
): TerminalAgentStatus {
  const { eventType, toolName, permissionMode } = event;
  const inPlanMode = isPlanPermissionMode(permissionMode);

  // Plan-review tool — fires both for interactive review and auto-accept.
  if (eventType === "PreToolUse" && isExitPlanTool(toolName)) {
    return "review_plan";
  }

  // In plan mode, Notification is usually "plan / mode attention", not a tool allow dialog.
  if (inPlanMode && eventType === "Notification") {
    return "review_plan";
  }

  // Plan-mode research tools: do not treat PreToolUse as waiting_approval.
  if (inPlanMode && eventType === "PreToolUse") {
    return "running";
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
