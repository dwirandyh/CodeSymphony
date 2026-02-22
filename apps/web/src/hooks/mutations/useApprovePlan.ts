import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";

export function useApprovePlan() {
  return useMutation({
    mutationFn: (threadId: string) => api.approvePlan(threadId),
  });
}
