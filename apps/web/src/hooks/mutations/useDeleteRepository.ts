import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useDeleteRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repositoryId: string) => api.deleteRepository(repositoryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
