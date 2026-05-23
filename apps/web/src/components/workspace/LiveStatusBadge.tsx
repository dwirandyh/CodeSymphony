import type { WorkspaceLiveConnectionState } from "@codesymphony/shared-types";
import { Badge } from "../ui/badge";
import {
  formatLiveUpdateMechanismLabel,
  formatLiveUpdateReplayLabel,
  LIVE_UPDATE_DOMAIN_POLICY,
  type LiveUpdateDomainId,
} from "../../lib/liveUpdatePolicy";
import {
  compareLiveStatusDisplayStateSeverity,
  formatLiveStatusDisplayStateLabel,
  resolveLiveStatusDisplayState,
  type LiveStatusDisplayState,
} from "../../lib/workspaceLiveBadgeState";
import { cn } from "../../lib/utils";

export type LiveStatusBadgeItem = {
  connectionState: WorkspaceLiveConnectionState | null;
  displayStateOverride?: LiveStatusDisplayState | null;
  domain: LiveUpdateDomainId;
  errorMessage?: string | null;
  label?: string;
};

const LIVE_STATUS_BADGE_CLASSNAME: Record<LiveStatusDisplayState, string> = {
  healthy: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  connecting: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  switching: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  reconnecting: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  stale: "border-amber-600/35 bg-amber-500/15 text-amber-800 dark:text-amber-200",
  exhausted: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
  unavailable: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
};

function resolveAggregateState(states: LiveStatusDisplayState[]) {
  const [firstState, ...remainingStates] = states;
  if (!firstState) {
    return "healthy";
  }

  return remainingStates.reduce<LiveStatusDisplayState>(
    (current, candidate) =>
      compareLiveStatusDisplayStateSeverity(current, candidate) >= 0 ? current : candidate,
    firstState,
  );
}

export function LiveStatusBadge({
  items,
  className,
  "data-testid": dataTestId,
}: {
  items: LiveStatusBadgeItem[];
  className?: string;
  "data-testid"?: string;
}) {
  const activeItems = items.filter(
    (item): item is LiveStatusBadgeItem & { connectionState: WorkspaceLiveConnectionState } => item.connectionState !== null,
  );
  if (activeItems.length === 0) {
    return null;
  }

  const itemStates = activeItems.map((item) => resolveLiveStatusDisplayState({
    connectionState: item.connectionState,
    displayStateOverride: item.displayStateOverride,
    errorMessage: item.errorMessage,
  })).filter((state): state is LiveStatusDisplayState => state !== null);
  const aggregateState = resolveAggregateState(itemStates);
  const title = [
    "Live update health",
    ...activeItems.map((item) => {
      const policy = LIVE_UPDATE_DOMAIN_POLICY[item.domain];
      const detail = item.errorMessage ? ` · ${item.errorMessage}` : "";
      const displayState = resolveLiveStatusDisplayState({
        connectionState: item.connectionState,
        displayStateOverride: item.displayStateOverride,
        errorMessage: item.errorMessage,
      });
      return `${item.label ?? policy.label}: ${formatLiveStatusDisplayStateLabel(displayState ?? "healthy")} · ${formatLiveUpdateMechanismLabel(policy.mechanism)} · ${formatLiveUpdateReplayLabel(policy.replayStrategy)}${detail}`;
    }),
  ].join("\n");

  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 shrink-0 gap-1.5 rounded-full px-2.5 text-[11px] font-medium",
        LIVE_STATUS_BADGE_CLASSNAME[aggregateState],
        className,
      )}
      title={title}
      aria-label={title}
      data-testid={dataTestId}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-85" aria-hidden="true" />
      {formatLiveStatusDisplayStateLabel(aggregateState)}
    </Badge>
  );
}
