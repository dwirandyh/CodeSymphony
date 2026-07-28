import type { ChatThread, ChatThreadPermissionMode } from "@codesymphony/shared-types";

/**
 * Mirrors the runtime's sticky permission mode so the composer can show the mode a new
 * thread will be created with before the server has answered. The runtime stays the source
 * of truth (see resolveInheritedPermissionMode in chatService.ts); this only avoids a
 * default -> full_access flicker in the pill.
 *
 * Returns null when there is nothing to inherit, so callers can keep their own fallback.
 */
export function resolveInheritedPermissionMode(
  threads: ChatThread[],
  worktreeId: string | null,
): ChatThreadPermissionMode | null {
  if (!worktreeId) {
    return null;
  }

  const candidates = threads.filter((thread) => (
    thread.worktreeId === worktreeId
    && thread.kind === "default"
    && !thread.isAutomation
  ));

  if (candidates.length === 0) {
    return null;
  }

  const latest = candidates.reduce((newest, thread) => (
    Date.parse(thread.updatedAt) > Date.parse(newest.updatedAt) ? thread : newest
  ));

  return latest.permissionMode === "full_access" ? "full_access" : "default";
}
