import { useMutation } from "@tanstack/react-query";
import type { DismissQuestionInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";

export function useDismissQuestion() {
  return useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: DismissQuestionInput }) =>
      api.dismissQuestion(threadId, input),
  });
}
