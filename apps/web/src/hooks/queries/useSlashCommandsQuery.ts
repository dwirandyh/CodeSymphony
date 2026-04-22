import type { CliAgent } from "@codesymphony/shared-types";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useSlashCommandsQuery(worktreeId: string | null, agent: CliAgent) {
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
    enabled: !!worktreeId,
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
}
