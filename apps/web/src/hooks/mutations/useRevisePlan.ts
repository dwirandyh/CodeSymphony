import { useMutation } from "@tanstack/react-query";
import type { PlanRevisionInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";

export function useRevisePlan() {
  return useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: PlanRevisionInput }) =>
      api.revisePlan(threadId, input),
  });
}
