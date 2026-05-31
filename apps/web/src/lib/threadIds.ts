export function isOptimisticThreadId(threadId: string | null | undefined): boolean {
  return threadId?.startsWith("optimistic-thread:") ?? false;
}
