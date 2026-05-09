import { asArray, asObject, asString } from "./protocolUtils.js";

type CodexCollaborationMode = {
  mode: "default" | "plan";
  settings: {
    model: string;
    reasoning_effort: "medium" | null;
    developer_instructions: null;
  };
};

export function buildCollaborationMode(model: string, permissionMode: string | undefined): CodexCollaborationMode {
  const mode = permissionMode === "plan" ? "plan" : "default";

  return {
    mode,
    settings: {
      model,
      // Match Codex app-server built-in collaboration presets. Passing null
      // developer instructions lets the installed Codex version inject its own
      // native template for the selected mode.
      reasoning_effort: mode === "plan" ? "medium" : null,
      developer_instructions: null,
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
