import type { ChatThreadStatus } from "@codesymphony/shared-types";

// Presentation for the non-idle, non-running thread statuses. `idle` renders
// nothing; `running` renders a spinner (handled by the caller). Shared by the
// worktree list and the terminal tab so both read the same labels/colors.
export const THREAD_STATUS_META: Record<
  Exclude<ChatThreadStatus, "idle" | "running">,
  { label: string; variant: "secondary" | "destructive" }
> = {
  waiting_approval: { label: "Waiting approval", variant: "destructive" },
  review_plan: { label: "Review plan", variant: "secondary" },
};
