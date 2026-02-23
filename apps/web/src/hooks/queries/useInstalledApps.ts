import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useInstalledApps() {
  return useQuery({
    queryKey: queryKeys.system.installedApps,
    queryFn: () => api.getInstalledApps(),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
