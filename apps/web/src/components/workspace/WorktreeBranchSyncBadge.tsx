import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { cn } from "../../lib/utils";

export type BranchSyncBadgeState = {
  showAhead: boolean;
  showBehind: boolean;
  tone: "behind";
};

export function resolveBranchSyncBadgeState(ahead: number, behind: number): BranchSyncBadgeState | null {
  if (behind <= 0) {
    return null;
  }

  return {
    showAhead: ahead > 0,
    showBehind: true,
    tone: "behind",
  };
}

export function WorktreeBranchSyncBadge({
  ahead,
  behind,
  baseBranch,
  testId,
}: {
  ahead: number;
  behind: number;
  baseBranch?: string;
  testId: string;
}) {
  const state = resolveBranchSyncBadgeState(ahead, behind);
  if (!state) {
    return null;
  }

  const behindLabel = `behind${baseBranch ? ` ${baseBranch}` : ""}`;
  const title = `${behind} commit${behind === 1 ? "" : "s"} ${behindLabel}${
    state.showAhead ? ` (${ahead} ahead)` : ""
  } — sync manually`;

  return (
    <span
      data-testid={`${testId}-branch-sync`}
      title={title}
      className={cn(
        "inline-flex h-3 shrink-0 items-center gap-0.5 text-[10px] leading-none text-amber-500",
      )}
    >
      {state.showAhead ? (
        <>
          <ArrowUpFromLine className="h-2.5 w-2.5" aria-hidden="true" />
          {ahead}
        </>
      ) : null}
      <ArrowDownToLine className="h-2.5 w-2.5" aria-hidden="true" />
      {behind}
    </span>
  );
}