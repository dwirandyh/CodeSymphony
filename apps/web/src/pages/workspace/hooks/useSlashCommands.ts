import { useSlashCommandsQuery } from "../../../hooks/queries/useSlashCommandsQuery";

export function useSlashCommands(worktreeId: string | null) {
  const { data, isLoading, refetch, error } = useSlashCommandsQuery(worktreeId);

  return {
    commands: data?.commands ?? [],
    loading: isLoading,
    error,
    refresh: () => void refetch(),
  };
}
