import type { WorkspaceLiveConnectionState } from "@codesymphony/shared-types";
import { LIVE_UPDATE_DOMAIN_POLICY, type LiveUpdateDomainId } from "./liveUpdatePolicy";
import {
  resolveLiveStatusDisplayState,
  type LiveStatusDisplayState,
} from "./workspaceLiveBadgeState";

export type WorkspaceLiveStatusItem = {
  connectionState: WorkspaceLiveConnectionState | null;
  displayStateOverride?: LiveStatusDisplayState | null;
  domain: LiveUpdateDomainId;
  errorMessage?: string | null;
  label?: string;
};

type WorkspaceLiveErrorItem = {
  description: string;
  displayState: Extract<LiveStatusDisplayState, "exhausted" | "unavailable">;
  domain: LiveUpdateDomainId;
  label: string;
};

export type WorkspaceLiveErrorSummary = {
  description: string;
  items: WorkspaceLiveErrorItem[];
  signature: string;
  title: string;
};

function isErrorDisplayState(
  state: LiveStatusDisplayState | null,
): state is Extract<LiveStatusDisplayState, "exhausted" | "unavailable"> {
  return state === "exhausted" || state === "unavailable";
}

function buildDefaultDescription(item: {
  displayState: Extract<LiveStatusDisplayState, "exhausted" | "unavailable">;
  label: string;
}) {
  if (item.displayState === "unavailable") {
    return `${item.label} is not available for the selected workspace.`;
  }

  return `${item.label} stopped receiving live updates.`;
}

export function resolveWorkspaceLiveErrorSummary(
  items: WorkspaceLiveStatusItem[],
): WorkspaceLiveErrorSummary | null {
  const errorItems = items.flatMap<WorkspaceLiveErrorItem>((item) => {
    if (item.connectionState === null) {
      return [];
    }

    const displayState = resolveLiveStatusDisplayState({
      connectionState: item.connectionState,
      displayStateOverride: item.displayStateOverride,
      errorMessage: item.errorMessage,
    });

    if (!isErrorDisplayState(displayState)) {
      return [];
    }

    const label = item.label ?? LIVE_UPDATE_DOMAIN_POLICY[item.domain].label;
    const description = item.errorMessage?.trim() || buildDefaultDescription({
      displayState,
      label,
    });

    return [{
      domain: item.domain,
      label,
      displayState,
      description,
    }];
  });

  if (errorItems.length === 0) {
    return null;
  }

  const title = errorItems.some((item) => item.displayState === "unavailable")
    ? "Selected workspace unavailable"
    : "Live updates unavailable";
  const description = errorItems.length === 1
    ? `${errorItems[0]!.label}: ${errorItems[0]!.description}`
    : errorItems.map((item) => `${item.label}: ${item.description}`).join("\n");

  return {
    title,
    description,
    items: errorItems,
    signature: JSON.stringify(errorItems.map((item) => ({
      domain: item.domain,
      displayState: item.displayState,
      description: item.description,
    }))),
  };
}
