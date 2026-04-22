import type { CliAgent } from "@codesymphony/shared-types";
import { useSlashCommandsQuery } from "../../../hooks/queries/useSlashCommandsQuery";

export function useSlashCommands(worktreeId: string | null, agent: CliAgent) {
  const { data, isLoading, refetch, error } = useSlashCommandsQuery(worktreeId, agent);

  return {
    commands: data?.commands ?? [],
    loading: isLoading,
    error,
    refresh: () => void refetch(),
  };
}
