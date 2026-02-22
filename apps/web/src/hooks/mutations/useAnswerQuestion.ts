import { useMutation } from "@tanstack/react-query";
import type { AnswerQuestionInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";

export function useAnswerQuestion() {
  return useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: AnswerQuestionInput }) =>
      api.answerQuestion(threadId, input),
  });
}
