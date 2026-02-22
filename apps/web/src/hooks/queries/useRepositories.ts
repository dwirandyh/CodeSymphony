import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useRepositories() {
  return useQuery({
    queryKey: queryKeys.repositories.all,
    queryFn: () => api.listRepositories(),
  });
}
