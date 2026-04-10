import type { ChatEvent } from "@codesymphony/shared-types";
import { extractExploreActivityGroups } from "../../exploreUtils";
import { extractSubagentGroups, isOverlapUnclaimedSubagentEvent } from "../../subagentUtils";
import type { ExploreActivityGroup, SubagentGroup } from "../../types";

type SubagentExploreExtractionResult = {
  subagentGroups: SubagentGroup[];
  exploreActivityGroups: ExploreActivityGroup[];
  subagentEventIds: Set<string>;
  exploreEventIds: Set<string>;
  overlapUnclaimedEventIds: Set<string>;
  claimedContextEventIds: Set<string>;
  unclaimedContextEventIds: string[];
};

export function extractSubagentExploreGroups(
  contextWithAgentBoundaries: ChatEvent[],
  options?: { previousClaimedContextEventIds?: Set<string> },
): SubagentExploreExtractionResult {
  const subagentGroups = extractSubagentGroups(contextWithAgentBoundaries);
  const subagentEventIds = new Set<string>();
  for (const group of subagentGroups) {
    group.eventIds.forEach((eventId) => subagentEventIds.add(eventId));
  }

  const overlapUnclaimedEventIds = new Set<string>();
  for (const event of contextWithAgentBoundaries) {
    if (isOverlapUnclaimedSubagentEvent(event.id)) {
      overlapUnclaimedEventIds.add(event.id);
    }
  }

  const exploreActivityGroups = extractExploreActivityGroups(
    contextWithAgentBoundaries.filter(
      (event) => !subagentEventIds.has(event.id) && !overlapUnclaimedEventIds.has(event.id),
    ),
  );
  const exploreEventIds = new Set<string>();
  for (const group of exploreActivityGroups) {
    group.eventIds.forEach((eventId) => exploreEventIds.add(eventId));
  }

  const contextEventIds = new Set(contextWithAgentBoundaries.map((event) => event.id));
  const claimedContextEventIds = new Set<string>([
    ...subagentEventIds,
    ...exploreEventIds,
    ...overlapUnclaimedEventIds,
  ]);

  if (options?.previousClaimedContextEventIds) {
    for (const eventId of options.previousClaimedContextEventIds) {
      if (contextEventIds.has(eventId) && !claimedContextEventIds.has(eventId)) {
        claimedContextEventIds.add(eventId);
      }
    }
  }

  const unclaimedContextEventIds = [...contextEventIds].filter((eventId) => !claimedContextEventIds.has(eventId));

  return {
    subagentGroups,
    exploreActivityGroups,
    subagentEventIds,
    exploreEventIds,
    overlapUnclaimedEventIds,
    claimedContextEventIds,
    unclaimedContextEventIds,
  };
}
