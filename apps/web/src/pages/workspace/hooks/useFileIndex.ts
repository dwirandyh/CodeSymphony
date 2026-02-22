import { useFileIndexQuery } from "../../../hooks/queries/useFileIndexQuery";

export function useFileIndex(worktreeId: string | null) {
  const { data, isLoading, refetch } = useFileIndexQuery(worktreeId);

  return {
    entries: data ?? [],
    loading: isLoading,
    refresh: () => void refetch(),
  };
}
