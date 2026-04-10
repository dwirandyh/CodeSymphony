import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useSlashCommandsQuery(worktreeId: string | null) {
  return useQuery({
    queryKey: queryKeys.worktrees.slashCommands(worktreeId!),
    queryFn: async () => {
      try {
        return await api.getSlashCommands(worktreeId!);
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
