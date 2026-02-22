import { useMutation } from "@tanstack/react-query";
import type { ResolvePermissionInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";

export function useResolvePermission() {
  return useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: ResolvePermissionInput }) =>
      api.resolvePermission(threadId, input),
  });
}
