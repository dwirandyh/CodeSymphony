import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { extractExploreActivityGroups } from "../exploreUtils";
import { extractSubagentGroups, getSubagentAttributionReason, isOverlapUnclaimedSubagentEvent } from "../subagentUtils";
import {
  countDiffStats,
  finishedToolUseIds,
  getEventMessageId,
  isBashToolEvent,
  isMetadataToolEvent,
  isPlanModeToolEvent,
  isWorktreeDiffEvent,
  parseTimestamp,
  payloadStringArray,
  payloadStringOrNull,
} from "../eventUtils";
import { extractBashRuns } from "../bashUtils";
import { extractEditedRuns } from "../editUtils";
import { pushRenderDebug } from "../debug";
import { logTimelineWarning } from "../logger";
import type { SortableEntry, TimelineRefs } from "./useWorkspaceTimeline.types";

function explicitSkillNameFromEvents(events: ChatEvent[]): string | null {
  for (const event of events) {
    const skillName = payloadStringOrNull(event.payload.skillName)?.trim().toLowerCase() ?? null;
    if (skillName) {
      return skillName;
    }
  }
  return null;
}

function isExplicitSkillToolEvent(event: ChatEvent): boolean {
  return (event.type === "tool.started" || event.type === "tool.output" || event.type === "tool.finished")
    && payloadStringOrNull(event.payload.toolName)?.toLowerCase() === "skill";
}

function toolRunId(event: ChatEvent): string | null {
  const runIds = event.type === "tool.finished"
    ? finishedToolUseIds(event)
    : [payloadStringOrNull(event.payload.toolUseId)].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return runIds[0] ?? null;
}

function skillToolRunId(event: ChatEvent): string | null {
  return toolRunId(event);
}

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
        id: `orphan:${group.id}`,
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
  const excludedToolUseIds = new Set<string>();
  for (const event of unassignedInlineEvents) {
    if (event.type !== "tool.finished") {
      continue;
    }
    const summary = payloadStringOrNull(event.payload.summary)?.trim().toLowerCase() ?? "";
    const hasSummaryChain = /&&|\|\||;|\|/.test(summary);
    if (summary.startsWith("failed to read") || (summary.startsWith("ran ls") && !hasSummaryChain)) {
      for (const runId of finishedToolUseIds(event)) {
        excludedToolUseIds.add(runId);
      }
    }
  }
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
  const orphanExploreCandidates = unassignedInlineEvents
    .filter((event) => !isOverlapUnclaimedSubagentEvent(event.id))
    .filter((event) => {
      const summary = payloadStringOrNull(event.payload.summary)?.trim().toLowerCase() ?? "";
      if (summary.startsWith("ran ls") || summary.startsWith("failed to read")) {
        return false;
      }
      if (event.type === "tool.started" || event.type === "tool.output") {
        const toolUseId = payloadStringOrNull(event.payload.toolUseId);
        if (toolUseId && excludedToolUseIds.has(toolUseId)) {
          return false;
        }
      }
      return true;
    });
  const orphanExploreGroups = extractExploreActivityGroups(orphanExploreCandidates);
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
  const failedReadToolUseIds = new Set<string>();
  for (const event of inlineToolEvents) {
    if (event.type !== "tool.finished") {
      continue;
    }
    const summary = payloadStringOrNull(event.payload.summary)?.trim().toLowerCase() ?? "";
    if (!summary.startsWith("failed to read")) {
      continue;
    }
    for (const runId of finishedToolUseIds(event)) {
      failedReadToolUseIds.add(runId);
    }
  }

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
    .filter((event) => {
      if (event.type === "tool.finished") {
        const summary = payloadStringOrNull(event.payload.summary)?.trim().toLowerCase() ?? "";
        if (summary.startsWith("failed to read")) {
          return true;
        }
      }

      if (event.type !== "tool.started" && event.type !== "tool.output") {
        return true;
      }

      const toolUseId = payloadStringOrNull(event.payload.toolUseId);
      if (!toolUseId) {
        return true;
      }

      return !failedReadToolUseIds.has(toolUseId);
    })
    .sort((a, b) => a.idx - b.idx);

  const explicitSkillToolEvents = orphanToolEvents.filter(isExplicitSkillToolEvent);
  const explicitSkillRunIds = new Set(
    explicitSkillToolEvents
      .map((event) => skillToolRunId(event))
      .filter((runId): runId is string => typeof runId === "string" && runId.length > 0),
  );
  const orphanSkillToolEvents = orphanToolEvents.filter((event) => {
    if (isExplicitSkillToolEvent(event)) {
      return true;
    }
    if (event.type !== "tool.finished") {
      return false;
    }
    const runId = skillToolRunId(event);
    return !!runId && explicitSkillRunIds.has(runId) && payloadStringOrNull(event.payload.summary)?.toLowerCase() === "completed skill";
  });
  const skillEventsByRunId = new Map<string, ChatEvent[]>();
  for (const event of orphanSkillToolEvents) {
    const runId = skillToolRunId(event);
    if (!runId) {
      continue;
    }
    const existing = skillEventsByRunId.get(runId) ?? [];
    existing.push(event);
    skillEventsByRunId.set(runId, existing);
  }

  for (const [runId, events] of skillEventsByRunId.entries()) {
    const sortedEvents = [...events].sort((a, b) => a.idx - b.idx);
    const primaryEvent = sortedEvents.find((event) => event.type === "tool.finished")
      ?? sortedEvents.find((event) => event.type === "tool.output")
      ?? sortedEvents[sortedEvents.length - 1]
      ?? null;
    if (!primaryEvent) {
      continue;
    }

    sortedEvents.forEach((event) => assignedToolEventIds.add(event.id));
    pushRenderDebug({
      source: "timelineOrphans",
      event: "coalescedSkillToolRun",
      details: {
        runId,
        eventIds: sortedEvents.map((event) => event.id),
        primaryEventId: primaryEvent.id,
      },
    });
    const explicitSkillName = explicitSkillNameFromEvents(sortedEvents);
    sortable.push({
      item: {
        kind: "tool",
        id: `orphan:skill:${runId}`,
        event: primaryEvent,
        sourceEvents: sortedEvents,
        toolUseId: runId,
        toolName: "Skill",
        summary: explicitSkillName ? `Using ${explicitSkillName} skill` : payloadStringOrNull(primaryEvent.payload.summary),
        output: typeof primaryEvent.payload.output === "string" ? primaryEvent.payload.output : null,
        error: typeof primaryEvent.payload.error === "string" ? primaryEvent.payload.error : null,
        truncated: primaryEvent.payload.truncated === true,
        durationSeconds: typeof primaryEvent.payload.elapsedTimeSeconds === "number" ? primaryEvent.payload.elapsedTimeSeconds : null,
        status: primaryEvent.type === "tool.started" ? "running" : typeof primaryEvent.payload.error === "string" && primaryEvent.payload.error.length > 0 ? "failed" : "success",
      },
      anchorIdx: primaryEvent.idx,
      timestamp: parseTimestamp(primaryEvent.createdAt),
      rank: 0,
      stableOrder: primaryEvent.idx,
    });
  }

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
      logTimelineWarning("Tool event not attached to assistant timeline", {
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

  const genericToolEventsByRunId = new Map<string, ChatEvent[]>();
  for (const event of orphanToolEvents) {
    if (assignedToolEventIds.has(event.id)) {
      continue;
    }
    if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
      continue;
    }
    const runId = toolRunId(event);
    if (!runId) {
      continue;
    }
    const existing = genericToolEventsByRunId.get(runId) ?? [];
    existing.push(event);
    genericToolEventsByRunId.set(runId, existing);
  }

  for (const [runId, events] of genericToolEventsByRunId.entries()) {
    const sortedEvents = [...events].sort((a, b) => a.idx - b.idx);
    const primaryEvent = sortedEvents.find((event) => event.type === "tool.finished")
      ?? sortedEvents.find((event) => event.type === "tool.output")
      ?? sortedEvents[sortedEvents.length - 1]
      ?? null;
    if (!primaryEvent) {
      continue;
    }

    const outputEvent = [...sortedEvents].reverse().find((event) => typeof event.payload.output === "string") ?? null;
    const errorEvent = [...sortedEvents].reverse().find((event) => typeof event.payload.error === "string") ?? null;
    const durationEvent = [...sortedEvents].reverse().find((event) => typeof event.payload.elapsedTimeSeconds === "number") ?? null;
    const hasFinishedEvent = sortedEvents.some((event) => event.type === "tool.finished");
    const resolvedError = errorEvent && typeof errorEvent.payload.error === "string" ? errorEvent.payload.error : null;
    const resolvedStatus = resolvedError
      ? "failed"
      : hasFinishedEvent
        ? "success"
        : "running";

    sortedEvents.forEach((event) => assignedToolEventIds.add(event.id));
    sortable.push({
      item: {
        kind: "tool",
        id: `orphan:tool:${runId}`,
        event: primaryEvent,
        sourceEvents: sortedEvents,
        toolUseId: runId,
        toolName: payloadStringOrNull(primaryEvent.payload.toolName),
        summary: payloadStringOrNull(primaryEvent.payload.summary),
        output: outputEvent && typeof outputEvent.payload.output === "string" ? outputEvent.payload.output : null,
        error: resolvedError,
        truncated: (outputEvent?.payload.truncated === true) || (errorEvent?.payload.truncated === true),
        durationSeconds: durationEvent && typeof durationEvent.payload.elapsedTimeSeconds === "number" ? durationEvent.payload.elapsedTimeSeconds : null,
        status: resolvedStatus,
      },
      anchorIdx: primaryEvent.idx,
      timestamp: parseTimestamp(primaryEvent.createdAt),
      rank: 0,
      stableOrder: primaryEvent.idx,
    });
  }

  const orphanEditedRuns = extractEditedRuns(
    orphanToolEvents.filter((event) => !assignedToolEventIds.has(event.id)),
  );
  for (const run of orphanEditedRuns) {
    run.eventIds.forEach((id) => assignedToolEventIds.add(id));
    sortable.push({
      item: {
        kind: "edited-diff",
        id: `orphan:${run.id}`,
        eventId: run.eventId,
        status: run.status,
        diffKind: run.diffKind,
        changedFiles: run.changedFiles,
        diff: run.diff,
        diffTruncated: run.diffTruncated,
        additions: run.additions,
        deletions: run.deletions,
        rejectedByUser: run.rejectedByUser,
        createdAt: run.createdAt,
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
    unassignedSemanticEvents = semanticContextEvents.filter((event) => !assignedSemanticEventIds.has(event.id));
    if (unassignedSemanticEvents.length > 0) {
      localHasIncompleteCoverage = true;
    }
  }

  if (messages.length > 0 && unassignedSemanticEvents.length > 0) {
    const unresolvedAssistantMessageIds = new Set<string>();
    for (const event of unassignedSemanticEvents) {
      if (event.type !== "message.delta") {
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
          logTimelineWarning("Hydration fallback attached unresolved assistant deltas to first assistant message", {
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
