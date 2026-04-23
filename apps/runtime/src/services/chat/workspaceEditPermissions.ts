import { isAbsolute, normalize, relative, resolve } from "node:path";
import { editTargetFromUnknownToolInput, isEditTool } from "../../claude/toolClassification.js";

function normalizeWorkspaceRelativePath(workspaceRoot: string, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedCandidate = trimmed.replace(/\\/g, "/");
  const relativePath = isAbsolute(trimmed)
    ? relative(workspaceRoot, resolve(trimmed)).replace(/\\/g, "/")
    : normalize(normalizedCandidate).replace(/\\/g, "/");
  const cleanPath = relativePath.replace(/^\.\/+/, "");

  if (
    cleanPath.length === 0
    || cleanPath === "."
    || cleanPath === ".."
    || cleanPath.startsWith("../")
  ) {
    return null;
  }

  return cleanPath;
}

function extractPermissionWriteTargets(toolInput: Record<string, unknown> | null | undefined): string[] {
  const permissions = toolInput?.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return [];
  }

  const fileSystem = (permissions as Record<string, unknown>).fileSystem;
  if (!fileSystem || typeof fileSystem !== "object" || Array.isArray(fileSystem)) {
    return [];
  }

  const writeTargets = (fileSystem as Record<string, unknown>).write;
  if (!Array.isArray(writeTargets)) {
    return [];
  }

  return writeTargets
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function shouldAutoApproveWorkspaceEdit(params: {
  workspaceRoot: string;
  toolName: string;
  toolInput?: Record<string, unknown> | null;
  blockedPath?: string | null;
}): boolean {
  const workspaceRoot = params.workspaceRoot.trim();
  if (workspaceRoot.length === 0) {
    return false;
  }

  if (isEditTool(params.toolName)) {
    const editTarget = params.blockedPath
      ?? editTargetFromUnknownToolInput(params.toolName, params.toolInput)
      ?? null;
    if (!editTarget) {
      return false;
    }
    return normalizeWorkspaceRelativePath(workspaceRoot, editTarget) !== null;
  }

  if (params.toolName.trim().toLowerCase() !== "permissions") {
    return false;
  }

  const writeTargets = extractPermissionWriteTargets(params.toolInput);
  if (writeTargets.length === 0) {
    return false;
  }

  return writeTargets.every((target) => normalizeWorkspaceRelativePath(workspaceRoot, target) !== null);
}

export const __testing = {
  normalizeWorkspaceRelativePath,
  extractPermissionWriteTargets,
};
