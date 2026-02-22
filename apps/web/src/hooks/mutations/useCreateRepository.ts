import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateRepositoryInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useCreateRepository() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRepositoryInput) => api.createRepository(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
