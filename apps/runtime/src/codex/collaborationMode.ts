import { asArray, asObject, asString } from "./protocolUtils.js";

export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in phases, and you should chat your way to a great plan before finalizing it. A great plan is implementation-ready and decision-complete.

Mode rules:
- You are in Plan Mode until a developer message explicitly ends it.
- If the user asks for execution while still in Plan Mode, treat it as a request to plan the execution, not perform it.

Plan Mode constraints:
- You may explore and execute non-mutating actions that improve the plan.
- You must not perform mutating actions or change repo-tracked state.

Allowed exploration:
- Read or search files, configs, manifests, and docs.
- Run non-mutating inspection commands.
- Run tests/builds/checks when they do not edit repo-tracked files.

Not allowed:
- Editing or writing files.
- Running commands whose purpose is to implement the change instead of refining the plan.
- Applying patches, migrations, or codegen that modifies repo-tracked files.

Planning workflow:
- Ground yourself in the actual environment before finalizing the plan.
- Resolve what you can through exploration before asking follow-up questions.
- Briefly summarize what you inspected before the final plan when that helps the user follow the reasoning.

Plan requirements:
- Clarify assumptions only when needed.
- Keep the plan decision-complete.
- Include interfaces, data flow, edge cases, and tests.
- Wrap the final plan in <proposed_plan> tags.
</collaboration_mode>`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Execute the user's request directly when possible.

Default mode constraints:
- Prefer making progress over asking follow-up questions.
- Only request user input when the runtime explicitly asks you to.
</collaboration_mode>`;

export function buildCollaborationMode(model: string, permissionMode: string | undefined) {
  return {
    mode: permissionMode === "plan" ? "plan" as const : "default" as const,
    settings: {
      model,
      reasoning_effort: "medium",
      developer_instructions: permissionMode === "plan"
        ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
        : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

export function resolveCodexRuntimePolicy(params: {
  permissionMode: "default" | "plan" | undefined;
  threadPermissionMode: "default" | "full_access" | undefined;
}): {
  approvalPolicy: "on-request" | "never";
  sandbox: "read-only" | "danger-full-access";
} {
  const permissionMode = params.permissionMode ?? "default";
  const threadPermissionMode = params.threadPermissionMode ?? "default";
  const approvalRequired = threadPermissionMode !== "full_access" || permissionMode === "plan";

  return {
    approvalPolicy: approvalRequired ? "on-request" : "never",
    sandbox: threadPermissionMode === "full_access" && permissionMode !== "plan"
      ? "danger-full-access"
      : "read-only",
  };
}

export function requestedPermissionsIncludeFileWrite(
  requestedPermissions: Record<string, unknown> | undefined,
): boolean {
  const fileSystem = asObject(requestedPermissions?.fileSystem);
  const writeEntries = asArray(fileSystem?.write)
    .map(asString)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return writeEntries.length > 0;
}

export function shouldAutoDeclineCodexPlanApproval(params: {
  permissionMode: "default" | "plan" | undefined;
  requestMethod: string;
  requestedPermissions?: Record<string, unknown> | undefined;
}): boolean {
  if (params.permissionMode !== "plan") {
    return false;
  }

  if (params.requestMethod === "item/fileChange/requestApproval") {
    return true;
  }

  if (params.requestMethod === "item/permissions/requestApproval") {
    return requestedPermissionsIncludeFileWrite(params.requestedPermissions);
  }

  return false;
}
