import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useFilesystemBrowse(path?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.filesystem.browse(path),
    queryFn: () => api.browseFilesystem(path),
    enabled,
  });
}
