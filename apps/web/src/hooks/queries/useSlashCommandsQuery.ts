import type { CliAgent } from "@codesymphony/shared-types";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

const SLASH_COMMANDS_FALLBACK_REFETCH_MS = 5 * 60_000;

export function useSlashCommandsQuery(
  worktreeId: string | null,
  agent: CliAgent,
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: queryKeys.worktrees.slashCommands(worktreeId!, agent),
    queryFn: async () => {
      try {
        return await api.getSlashCommands(worktreeId!, agent);
      } catch {
        return {
          commands: [],
          updatedAt: new Date(0).toISOString(),
        };
      }
    },
    enabled: (options?.enabled ?? true) && !!worktreeId,
    refetchInterval: options?.refetchInterval ?? SLASH_COMMANDS_FALLBACK_REFETCH_MS,
    staleTime: SLASH_COMMANDS_FALLBACK_REFETCH_MS - 5_000,
  });
}
