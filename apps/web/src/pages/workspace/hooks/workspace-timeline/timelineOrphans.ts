import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { extractExploreActivityGroups } from "../../exploreUtils";
import { extractSubagentGroups, getSubagentAttributionReason, isOverlapUnclaimedSubagentEvent } from "../../subagentUtils";
import {
  countDiffStats,
  getEventMessageId,
  isBashToolEvent,
  isMetadataToolEvent,
  isPlanModeToolEvent,
  isWorktreeDiffEvent,
  parseTimestamp,
  payloadStringArray,
  payloadStringOrNull,
} from "../../eventUtils";
import { extractBashRuns } from "../../bashUtils";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import { logService } from "../../../../lib/logService";
import type { SortableEntry, TimelineRefs } from "./useWorkspaceTimeline.types";

export function processOrphanSubagentGroups(
  inlineToolEvents: ChatEvent[],
  assignedToolEventIds: Set<string>,
  chatTerminated: boolean,
  sortable: SortableEntry[],
): void {
  const unassignedInlineEvents = inlineToolEvents.filter(
    (event) => !assignedToolEventIds.has(event.id),
  );
  const orphanSubagentGroups = extractSubagentGroups(unassignedInlineEvents);
  for (const group of orphanSubagentGroups) {
    group.eventIds.forEach((id) => assignedToolEventIds.add(id));
    const resolvedStatus = group.status === "running" && chatTerminated ? "success" : group.status;
    const resolvedSteps = chatTerminated
      ? group.steps.map((s) => s.status === "running" ? { ...s, status: "success" as const } : s)
      : group.steps;
    sortable.push({
      item: {
        kind: "subagent-activity",
        id: group.toolUseId,
        agentId: group.agentId,
        agentType: group.agentType,
        toolUseId: group.toolUseId,
        status: resolvedStatus,
        description: group.description,
        lastMessage: group.lastMessage,
        steps: resolvedSteps,
        durationSeconds: group.durationSeconds,
      },
      anchorIdx: group.anchorIdx,
      timestamp: parseTimestamp(group.createdAt),
      rank: 3,
      stableOrder: group.startIdx,
    });
  }
}

export function processOrphanExploreGroups(
  inlineToolEvents: ChatEvent[],
  assignedToolEventIds: Set<string>,
  chatTerminated: boolean,
  sortable: SortableEntry[],
): void {
  const unassignedInlineEvents = inlineToolEvents.filter(
    (event) => !assignedToolEventIds.has(event.id),
  );
  const quarantinedExploreEvents = unassignedInlineEvents.filter((event) => isOverlapUnclaimedSubagentEvent(event.id));
  if (quarantinedExploreEvents.length > 0) {
    pushRenderDebug({
      source: "timelineOrphans",
      event: "quarantinedOverlapSubagentExploreEvents",
      details: {
        eventIds: quarantinedExploreEvents.map((event) => event.id),
        reasonCodes: quarantinedExploreEvents.map((event) => ({
          eventId: event.id,
          reasonCode: getSubagentAttributionReason(event.id),
        })),
      },
    });
  }
  const orphanExploreGroups = extractExploreActivityGroups(
    unassignedInlineEvents.filter((event) => !isOverlapUnclaimedSubagentEvent(event.id)),
  );
  for (const group of orphanExploreGroups) {
    pushRenderDebug({
      source: "timelineOrphans",
      event: "orphanExploreGroup",
      details: {
        groupId: group.id,
        status: group.status,
        eventIds: [...group.eventIds],
        reasonCodes: [...group.eventIds]
          .map((eventId) => ({ eventId, reasonCode: getSubagentAttributionReason(eventId) }))
          .filter((entry) => entry.reasonCode !== null),
      },
    });
    group.eventIds.forEach((id) => assignedToolEventIds.add(id));
    const resolvedStatus = group.status === "running" && chatTerminated ? "success" : group.status;
    const resolvedEntries = chatTerminated
      ? group.entries.map((entry) => entry.pending ? { ...entry, pending: false } : entry)
      : group.entries;
    sortable.push({
      item: {
        kind: "explore-activity",
        id: `orphan:${group.id}`,
        status: resolvedStatus,
        fileCount: group.fileCount,
        searchCount: group.searchCount,
        entries: resolvedEntries,
      },
      anchorIdx: group.anchorIdx,
      timestamp: parseTimestamp(group.createdAt),
      rank: 3,
      stableOrder: group.startIdx,
    });
  }
}

export function processOrphanToolEvents(
  inlineToolEvents: ChatEvent[],
  assignedToolEventIds: Set<string>,
  hasEditedRunsWithDiffs: boolean,
  messages: ChatMessage[],
  sortable: SortableEntry[],
  selectedThreadId: string | null,
  refs: TimelineRefs,
): { orphanToolEvents: ChatEvent[]; hasIncompleteCoverage: boolean } {
  const orphanToolEvents = inlineToolEvents
    .filter((event) => !assignedToolEventIds.has(event.id))
    .filter((event) => !isOverlapUnclaimedSubagentEvent(event.id))
    .filter((event) =>
      event.type !== "permission.requested"
      && event.type !== "permission.resolved"
      && event.type !== "subagent.started"
      && event.type !== "subagent.finished"
      && event.type !== "plan.created"
      && event.type !== "plan.approved"
      && event.type !== "plan.revision_requested"
      && event.type !== "chat.failed"
      && !isPlanModeToolEvent(event)
      && !isMetadataToolEvent(event)
    )
    .sort((a, b) => a.idx - b.idx);

  const hasIncompleteCoverage = false;

  pushRenderDebug({
    source: "WorkspacePage",
    event: "activityOrphanToolEvents",
    details: {
      inlineToolEventCount: inlineToolEvents.length,
      assignedToolEventCount: assignedToolEventIds.size,
      orphanCount: orphanToolEvents.length,
      orphanEvents: orphanToolEvents.map((event) => ({
        id: event.id,
        idx: event.idx,
        type: event.type,
        reasonCode: getSubagentAttributionReason(event.id),
      })),
    },
  });

  if (selectedThreadId) {
    let loggedOrphanEventIds = refs.loggedOrphanEventIdsByThread.get(selectedThreadId);
    if (!loggedOrphanEventIds) {
      loggedOrphanEventIds = new Set<string>();
      refs.loggedOrphanEventIdsByThread.set(selectedThreadId, loggedOrphanEventIds);
    }
    for (const event of orphanToolEvents) {
      if (loggedOrphanEventIds.has(event.id)) {
        continue;
      }

      loggedOrphanEventIds.add(event.id);
      logService.log("warn", "chat.sync", "Tool event not attached to assistant timeline", {
        threadId: selectedThreadId,
        eventId: event.id,
        idx: event.idx,
        type: event.type,
        toolUseId: typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : null,
        toolName: typeof event.payload.toolName === "string" ? event.payload.toolName : null,
      });
    }
  }

  const orphanBashRuns = extractBashRuns(orphanToolEvents.filter((event) => isBashToolEvent(event) || event.type === "permission.requested" || event.type === "permission.resolved"));
  for (const run of orphanBashRuns) {
    run.eventIds.forEach((id) => assignedToolEventIds.add(id));
    const sourceEvents = orphanToolEvents.filter((event) => run.eventIds.has(event.id));
    sortable.push({
      item: {
        kind: "tool",
        id: `orphan:${run.id}`,
        event: sourceEvents[sourceEvents.length - 1] ?? null,
        sourceEvents,
        toolUseId: run.toolUseId,
        toolName: "Bash",
        shell: "bash",
        command: run.command,
        summary: run.summary,
        output: run.output,
        error: run.error,
        truncated: run.truncated,
        durationSeconds: run.durationSeconds,
        status: run.status,
        rejectedByUser: run.rejectedByUser,
      },
      anchorIdx: run.anchorIdx,
      timestamp: parseTimestamp(run.createdAt),
      rank: 0,
      stableOrder: run.startIdx,
    });
  }

  for (const event of orphanToolEvents) {
    if (assignedToolEventIds.has(event.id)) {
      continue;
    }

    if (isWorktreeDiffEvent(event)) {
      const hasRunsWithDiffs = hasEditedRunsWithDiffs;
      if (hasRunsWithDiffs) {
        continue;
      }
      const diff = payloadStringOrNull(event.payload.diff) ?? "";
      const { additions, deletions } = countDiffStats(diff);
      sortable.push({
        item: {
          kind: "edited-diff",
          id: `orphan:${event.id}`,
          eventId: event.id,
          status: "success",
          diffKind: "actual",
          changedFiles: payloadStringArray(event.payload.changedFiles),
          diff,
          diffTruncated: event.payload.diffTruncated === true,
          additions,
          deletions,
          rejectedByUser: false,
          createdAt: event.createdAt,
        },
        anchorIdx: event.idx,
        timestamp: parseTimestamp(event.createdAt),
        rank: 0,
        stableOrder: event.idx,
      });
      continue;
    }

    sortable.push({
      item: {
        kind: "tool",
        id: `orphan:${event.id}`,
        event,
        sourceEvents: [event],
        toolUseId: typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : undefined,
        toolName: typeof event.payload.toolName === "string" ? event.payload.toolName : null,
        summary: typeof event.payload.summary === "string" ? event.payload.summary : null,
        output: typeof event.payload.output === "string" ? event.payload.output : null,
        error: typeof event.payload.error === "string" ? event.payload.error : null,
        truncated: event.payload.truncated === true,
        durationSeconds: typeof event.payload.elapsedTimeSeconds === "number" ? event.payload.elapsedTimeSeconds : null,
        status: event.type === "tool.started" ? "running" : typeof event.payload.error === "string" && event.payload.error.length > 0 ? "failed" : "success",
      },
      anchorIdx: event.idx,
      timestamp: parseTimestamp(event.createdAt),
      rank: 0,
      stableOrder: event.idx,
    });
  }

  return { orphanToolEvents, hasIncompleteCoverage };
}

export function processUnassignedSemanticEvents(
  semanticContextEvents: ChatEvent[],
  assignedToolEventIds: Set<string>,
  assistantContextById: Map<string, ChatEvent[]>,
  assistantDeltaEventsByMessageId: Map<string, ChatEvent[]>,
  thinkingDeltaEventsByMessageId: Map<string, ChatEvent[]>,
  sortedMessages: ChatMessage[],
  messageAnchorIdxById: Map<string, number>,
  completedMessageIds: Set<string>,
  messages: ChatMessage[],
  hasIncompleteCoverage: boolean,
  semanticHydrationInProgress: boolean,
  selectedThreadId: string | null,
  sortable: SortableEntry[],
): boolean {
  let localHasIncompleteCoverage = hasIncompleteCoverage;
  let unassignedSemanticEvents: ChatEvent[] = [];

  if (messages.length > 0 && !localHasIncompleteCoverage) {
    const assignedSemanticEventIds = new Set<string>(assignedToolEventIds);
    for (const [messageId, contextEvents] of assistantContextById.entries()) {
      if (!sortedMessages.some((message) => message.id === messageId && message.role === "assistant")) {
        continue;
      }
      for (const event of contextEvents) {
        assignedSemanticEventIds.add(event.id);
      }
    }
    for (const deltaEvents of assistantDeltaEventsByMessageId.values()) {
      for (const event of deltaEvents) {
        assignedSemanticEventIds.add(event.id);
      }
    }
    for (const thinkingEvents of thinkingDeltaEventsByMessageId.values()) {
      for (const event of thinkingEvents) {
        assignedSemanticEventIds.add(event.id);
      }
    }

    unassignedSemanticEvents = semanticContextEvents.filter((event) => !assignedSemanticEventIds.has(event.id));
    if (unassignedSemanticEvents.length > 0) {
      localHasIncompleteCoverage = true;
    }
  }

  if (messages.length > 0 && unassignedSemanticEvents.length > 0) {
    const unresolvedAssistantMessageIds = new Set<string>();
    for (const event of unassignedSemanticEvents) {
      if (event.type !== "message.delta" && event.type !== "thinking.delta") {
        continue;
      }
      const messageId = getEventMessageId(event);
      if (!messageId) {
        continue;
      }
      const hasMessage = sortedMessages.some((message) => message.id === messageId && message.role === "assistant");
      if (!hasMessage) {
        unresolvedAssistantMessageIds.add(messageId);
      }
    }

    if (unresolvedAssistantMessageIds.size > 0) {
      if (semanticHydrationInProgress) {
        localHasIncompleteCoverage = true;
      } else {
        const firstAssistantMessage = sortedMessages.find((message) => message.role === "assistant") ?? null;
        if (firstAssistantMessage) {
          const firstAssistantAnchor = messageAnchorIdxById.get(firstAssistantMessage.id) ?? firstAssistantMessage.seq;
          sortable.push({
            item: {
              kind: "message",
              message: firstAssistantMessage,
              renderHint: "markdown",
              rawFileLanguage: undefined,
              isCompleted: completedMessageIds.has(firstAssistantMessage.id),
              context: [],
            },
            anchorIdx: firstAssistantAnchor,
            timestamp: parseTimestamp(firstAssistantMessage.createdAt),
            rank: 3,
            stableOrder: firstAssistantMessage.seq,
          });

          const unresolvedIds = Array.from(unresolvedAssistantMessageIds).sort();
          logService.log("warn", "chat.sync", "Hydration fallback attached unresolved assistant deltas to first assistant message", {
            threadId: selectedThreadId,
            fallbackMessageId: firstAssistantMessage.id,
            unresolvedMessageIds: unresolvedIds,
            unresolvedMessageCount: unresolvedIds.length,
          });
        }
      }
    }
  }

  return localHasIncompleteCoverage;
}

export function processFailedEvents(
  inlineToolEvents: ChatEvent[],
  assignedToolEventIds: Set<string>,
  sortable: SortableEntry[],
): void {
  const failedEvents = inlineToolEvents.filter(
    (event) => event.type === "chat.failed" && !assignedToolEventIds.has(event.id),
  );
  for (const event of failedEvents) {
    const errorMessage = typeof event.payload.message === "string"
      ? event.payload.message
      : typeof event.payload.error === "string"
        ? event.payload.error
        : "Chat failed";
    sortable.push({
      item: {
        kind: "error",
        id: `error:${event.id}`,
        message: errorMessage,
        createdAt: event.createdAt,
      },
      anchorIdx: event.idx,
      timestamp: parseTimestamp(event.createdAt),
      rank: 3,
      stableOrder: event.idx,
    });
  }
}
