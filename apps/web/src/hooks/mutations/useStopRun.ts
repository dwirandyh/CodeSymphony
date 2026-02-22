import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";

export function useStopRun() {
  return useMutation({
    mutationFn: (threadId: string) => api.stopRun(threadId),
  });
}
