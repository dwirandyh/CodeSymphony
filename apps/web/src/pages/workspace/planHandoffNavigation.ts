import type { WorkspaceSearch } from "../../routes";

export function buildPlanHandoffSearchPatch(executionThreadId: string): Partial<WorkspaceSearch> {
  return {
    view: undefined,
    file: undefined,
    fileLine: undefined,
    fileColumn: undefined,
    threadId: executionThreadId,
  };
}
