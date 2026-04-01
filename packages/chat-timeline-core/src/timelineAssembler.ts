import type { AssistantRenderHint, ChatEvent, ChatMessage, ChatTimelineItem, ChatTimelineSummary } from "@codesymphony/shared-types";
import { INLINE_TOOL_EVENT_TYPES, MAX_ORDER_INDEX } from "./constants";
import { extractBashRuns } from "./bashUtils";
import { extractEditedRuns } from "./editUtils";
import { extractSubagentExploreGroups } from "./workspace-timeline/subagentExploreExtraction";
import {
  buildActivityIntroText,
  buildActivitySteps,
  computeDurationSecondsFromEvents,
  finishedToolUseIds,
  getCompletedMessageId,
  getEventMessageId,
  hasUnclosedCodeFence,
  isBashToolEvent,
  isExploreLikeBashEvent,
  isLikelyDiffContent,
  isPlanFilePath,
  isReadToolEvent,
  normalizePlanCreatedEvent,
  parseTimestamp,
  payloadStringOrNull,
  promptLooksLikeFileRead,
} from "./eventUtils";
import { computeMessageAnchorIdxById } from "./workspace-timeline/timelineAnchorUtils";
import {
  buildInlineInserts,
  buildSegmentBuckets,
  applySubagentContentCleaning,
  rebalanceSentenceAwareSegmentBuckets,
  mergeSmallSegments,
  fixPunctuationSplits,
  processInlineInsertLoop,
  filterPostPlanDeltaEvents,
} from "./workspace-timeline/timelineInlineInserts";
import {
  processOrphanSubagentGroups,
  processOrphanExploreGroups,
  processOrphanToolEvents,
  processUnassignedSemanticEvents,
  processFailedEvents,
} from "./workspace-timeline/timelineOrphans";
import { sanitizeAssistantVisibleText } from "./textUtils";
import { pushRenderDebug } from "./debug";

const SUBAGENT_SUMMARY_REGEX = /###subagent summary(?:\s+start)?\n?([\s\S]*?)###subagent summary end\n?/g;
const MAIN_SUMMARY_REGEX = /###main(?:\s+agent)? summary(?:\s+start)?\n?[\s\S]*?###main(?:\s+agent)? summary end\n?/g;
const MAIN_SUMMARY_START_MARKER = /###main(?:\s+agent)? summary(?:\s+start)?\n?/g;
const MAIN_SUMMARY_END_MARKER = /###main(?:\s+agent)? summary end\n?/g;
const MULTI_FILE_EDIT_ANNOUNCEMENT_PATTERN = /\b(both files|two files|2 files?|kedua file|dua file)\b/i;
const SINGLE_EDIT_ANNOUNCEMENT_PATTERN = /\b(mari saya|let me|i'?ll|saya akan|now let me)\b/i;
const COMPLETION_MESSAGE_PATTERN = /^(sip|selesai|done|fixed|beres|sudah)/i;

type TimelineRefs = {
  streamingMessageIds: Set<string>;
  stickyRawFallbackMessageIds: Set<string>;
  renderDecisionByMessageId: Map<string, string>;
  loggedOrphanEventIdsByThread: Map<string, Set<string>>;
  loggedFirstInsertOrderByMessageId: Set<string>;
};

type SortableEntry = {
  item: ChatTimelineItem;
  anchorIdx: number;
  timestamp: number | null;
  rank: number;
  stableOrder: number;
};

type PlanFileOutput = {
  id: string;
  messageId: string;
  content: string;
  filePath: string;
  idx: number;
  createdAt: string;
};

function rebalanceMultiFileEditAnnouncements(sortable: SortableEntry[]): void {
  for (let index = 1; index < sortable.length - 1; index += 1) {
    const previous = sortable[index - 1];
    const current = sortable[index];
    const next = sortable[index + 1];

    if (previous?.item.kind !== "edited-diff" || current?.item.kind !== "message" || next?.item.kind !== "edited-diff") {
      continue;
    }

    const content = current.item.message.content.trim();
    if (!content.endsWith(":") || !MULTI_FILE_EDIT_ANNOUNCEMENT_PATTERN.test(content)) {
      continue;
    }

    current.anchorIdx = Math.min(current.anchorIdx, previous.anchorIdx - 1);
    current.stableOrder = Math.min(current.stableOrder, previous.stableOrder - 0.0005);
  }
}

function rebalanceTrailingSingleEditAnnouncements(sortable: SortableEntry[]): void {
  for (let index = 2; index < sortable.length; index += 1) {
    const twoBack = sortable[index - 2];
    const previous = sortable[index - 1];
    const current = sortable[index];

    if (twoBack?.item.kind !== "edited-diff" || previous?.item.kind !== "message" || current?.item.kind !== "message") {
      continue;
    }

    const completionContent = currentString(previous.item.message.content);
    const announcementContent = currentString(current.item.message.content);
    if (!COMPLETION_MESSAGE_PATTERN.test(completionContent.trim())) {
      continue;
    }
    if (!announcementContent.trim().endsWith(":") || announcementContent.trim().length > 120 || !SINGLE_EDIT_ANNOUNCEMENT_PATTERN.test(announcementContent)) {
      continue;
    }

    current.anchorIdx = Math.min(current.anchorIdx, twoBack.anchorIdx - 1);
    current.stableOrder = Math.min(current.stableOrder, twoBack.stableOrder - 0.0005);
  }
}

function currentString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeTrailingEditAnnouncementOrder(items: ChatTimelineItem[]): ChatTimelineItem[] {
  const nextItems = [...items];
  for (let index = 0; index <= nextItems.length - 3; index += 1) {
    const current = nextItems[index];
    const next = nextItems[index + 1];
    const trailing = nextItems[index + 2];
    if (current?.kind !== "edited-diff" || next?.kind !== "message" || trailing?.kind !== "message") {
      continue;
    }

    const completionContent = currentString(next.message.content).trim();
    const announcementContent = currentString(trailing.message.content).trim();
    if (!COMPLETION_MESSAGE_PATTERN.test(completionContent)) {
      continue;
    }
    if (!announcementContent.endsWith(":") || announcementContent.length > 120 || !SINGLE_EDIT_ANNOUNCEMENT_PATTERN.test(announcementContent)) {
      continue;
    }

    nextItems.splice(index + 2, 1);
    nextItems.splice(index, 0, trailing);
    index += 1;
  }

  return nextItems;
}

export type TimelineAssemblyResult = {
  items: ChatTimelineItem[];
  summary: ChatTimelineSummary;
  hasIncompleteCoverage: boolean;
};

export function buildTimelineFromSeed(params: {
  messages: ChatMessage[];
  events: ChatEvent[];
  selectedThreadId: string | null;
  semanticHydrationInProgress?: boolean;
}): TimelineAssemblyResult {
  const { messages, events, selectedThreadId, semanticHydrationInProgress = false } = params;
  const refs: TimelineRefs = {
    streamingMessageIds: new Set(),
    stickyRawFallbackMessageIds: new Set(),
    renderDecisionByMessageId: new Map(),
    loggedOrphanEventIdsByThread: new Map(),
    loggedFirstInsertOrderByMessageId: new Set(),
  };

  const sortedMessages = [...messages].sort((a, b) => a.seq - b.seq);
  const orderedEventsByIdx = [...events].sort((a, b) => a.idx - b.idx);

  const firstMessageEventIdxById = new Map<string, number>();
  const completedMessageIds = new Set<string>();
  const completedEventIdxByMessageId = new Map<string, number>();
  for (const event of orderedEventsByIdx) {
    const messageId = getEventMessageId(event);
    if (messageId) {
      const currentIdx = firstMessageEventIdxById.get(messageId);
      if (currentIdx == null || event.idx < currentIdx) {
        firstMessageEventIdxById.set(messageId, event.idx);
      }
    }

    const completedId = getCompletedMessageId(event);
    if (completedId) {
      completedMessageIds.add(completedId);
      const currentCompletedIdx = completedEventIdxByMessageId.get(completedId);
      if (currentCompletedIdx == null || event.idx < currentCompletedIdx) {
        completedEventIdxByMessageId.set(completedId, event.idx);
      }
    }
  }

  const planFileOutputByMessageId = new Map<string, PlanFileOutput>();
  for (const event of orderedEventsByIdx) {
    const normalizedPlan = normalizePlanCreatedEvent(event, orderedEventsByIdx);
    if (!normalizedPlan || normalizedPlan.messageId.length === 0) {
      continue;
    }

    planFileOutputByMessageId.set(normalizedPlan.messageId, normalizedPlan);
  }

  const messageAnchorIdxById = computeMessageAnchorIdxById(
    sortedMessages,
    firstMessageEventIdxById,
    completedEventIdxByMessageId,
  );
  const latestUserPromptByAssistantId = new Map<string, string>();
  let latestUserPrompt = "";
  for (const message of sortedMessages) {
    if (message.role === "user") {
      latestUserPrompt = message.content;
      continue;
    }

    if (message.role === "assistant") {
      latestUserPromptByAssistantId.set(message.id, latestUserPrompt);
    }
  }

  const inlineToolEvents = orderedEventsByIdx.filter((event) => INLINE_TOOL_EVENT_TYPES.has(event.type));
  const semanticContextEvents = orderedEventsByIdx.filter((event) =>
    event.type === "tool.started"
    || event.type === "tool.output"
    || event.type === "tool.finished"
    || event.type === "subagent.started"
    || event.type === "subagent.finished"
    || event.type === "plan.created"
    || event.type === "plan.approved"
    || event.type === "plan.revision_requested"
  );
  const assistantDeltaEventsByMessageId = new Map<string, ChatEvent[]>();
  for (const event of orderedEventsByIdx) {
    if (event.type !== "message.delta" || event.payload.role !== "assistant") {
      continue;
    }

    const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : null;
    if (!messageId) {
      continue;
    }

    const existing = assistantDeltaEventsByMessageId.get(messageId) ?? [];
    existing.push(event);
    assistantDeltaEventsByMessageId.set(messageId, existing);
  }

  const assistantContextById = new Map<string, ChatEvent[]>();
  const assistantMessages = sortedMessages.filter((message) => message.role === "assistant");
  const assistantStartIdxByMessageId = new Map<string, number>();
  const nextAssistantStartIdxByMessageId = new Map<string, number>();
  for (const message of assistantMessages) {
    const startIdx = firstMessageEventIdxById.get(message.id);
    if (typeof startIdx === "number") {
      assistantStartIdxByMessageId.set(message.id, startIdx);
    }
  }

  for (let index = 0; index < assistantMessages.length; index += 1) {
    const currentMessage = assistantMessages[index];
    for (let nextIndex = index + 1; nextIndex < assistantMessages.length; nextIndex += 1) {
      const nextStartIdx = assistantStartIdxByMessageId.get(assistantMessages[nextIndex].id);
      if (typeof nextStartIdx === "number") {
        nextAssistantStartIdxByMessageId.set(currentMessage.id, nextStartIdx);
        break;
      }
    }
  }

  let previousAssistantBoundaryIdx = -1;
  for (const message of assistantMessages) {
    const messageStartIdx = assistantStartIdxByMessageId.get(message.id);
    const completedIdx = completedEventIdxByMessageId.get(message.id);
    const nextAssistantStartIdx = nextAssistantStartIdxByMessageId.get(message.id);
    const lowerBoundaryIdx =
      typeof messageStartIdx === "number"
        ? messageStartIdx - 1
        : previousAssistantBoundaryIdx;
    const upperBoundaryIdx =
      typeof completedIdx === "number"
        ? completedIdx
        : typeof nextAssistantStartIdx === "number"
          ? nextAssistantStartIdx - 1
          : Number.POSITIVE_INFINITY;
    const context = inlineToolEvents.filter((event) => event.idx > lowerBoundaryIdx && event.idx <= upperBoundaryIdx);
    assistantContextById.set(message.id, context);
    if (Number.isFinite(upperBoundaryIdx)) {
      previousAssistantBoundaryIdx = Math.max(previousAssistantBoundaryIdx, upperBoundaryIdx);
    }
  }

  const sortable: SortableEntry[] = [];
  const assignedToolEventIds = new Set<string>();
  let hasEditedRunsWithDiffs = false;
  let hasIncompleteCoverage = false;
  const oldestAssistantMessageId = sortedMessages.find((message) => message.role === "assistant")?.id ?? null;
  const chatTerminated = orderedEventsByIdx.some(
    (event) => event.type === "chat.completed" || event.type === "chat.failed",
  );

  for (const message of sortedMessages) {
    const anchorIdx = messageAnchorIdxById.get(message.id) ?? message.seq;
    const firstAssistantDeltaTimestamp = message.role === "assistant"
      ? parseTimestamp(assistantDeltaEventsByMessageId.get(message.id)?.[0]?.createdAt ?? "")
      : null;
    const timestamp = parseTimestamp(message.createdAt) ?? firstAssistantDeltaTimestamp;
    const context = message.role === "assistant" ? assistantContextById.get(message.id) ?? [] : [];
    const nearestUserPrompt = latestUserPromptByAssistantId.get(message.id) ?? "";
    const hasReadContext = context.some((event) => isReadToolEvent(event));
    const looksLikeFileRead = promptLooksLikeFileRead(nearestUserPrompt);
    const isReadResponseContext = hasReadContext || looksLikeFileRead;
    const hasMessageDelta = firstMessageEventIdxById.has(message.id);
    const isCompleted = message.role === "assistant" ? completedMessageIds.has(message.id) : false;
    const planFileOutput = message.role === "assistant" ? planFileOutputByMessageId.get(message.id) : undefined;
    const shouldSkipMessageBecausePlanCard =
      message.role === "assistant"
      && !!planFileOutput
      && message.content.trim().length > 0
      && message.content.trim() === planFileOutput.content.trim();

    const hasToolEventsInContext = message.role === "assistant"
      && (assistantContextById.get(message.id)?.length ?? 0) > 0;
    const oldestAssistantMissingRichContext =
      message.role === "assistant"
      && oldestAssistantMessageId != null
      && message.id === oldestAssistantMessageId
      && message.content.trim().length > 0
      && !hasToolEventsInContext
      && !hasMessageDelta;
    if (oldestAssistantMissingRichContext) {
      hasIncompleteCoverage = true;
    }

    if (
      message.role === "assistant"
      && !hasToolEventsInContext
      && (shouldSkipMessageBecausePlanCard || (message.content.trim().length === 0 && !isCompleted && !hasMessageDelta))
    ) {
      continue;
    }

    const hasUnclosedFence = message.role === "assistant" ? hasUnclosedCodeFence(message.content) : false;
    if (message.role === "assistant" && !isCompleted && hasUnclosedFence && !isReadResponseContext) {
      refs.stickyRawFallbackMessageIds.add(message.id);
    }
    if (message.role === "assistant" && isCompleted) {
      refs.stickyRawFallbackMessageIds.delete(message.id);
    }

    const shouldRenderRawFallback =
      message.role === "assistant"
      && !isCompleted
      && !isReadResponseContext
      && refs.stickyRawFallbackMessageIds.has(message.id);
    const isStreamingMessage = message.role === "assistant" && refs.streamingMessageIds.has(message.id) && !isCompleted;

    let renderHint: AssistantRenderHint | undefined;
    let rawFileLanguage: string | undefined;
    if (message.role === "assistant") {
      if (isLikelyDiffContent(message.content)) {
        renderHint = "diff";
      } else if (shouldRenderRawFallback) {
        renderHint = isStreamingMessage ? "markdown" : "raw-fallback";
      } else {
        renderHint = "markdown";
      }
    }

    const deltaEventsForAgent = message.role === "assistant"
      ? (assistantDeltaEventsByMessageId.get(message.id) ?? [])
      : [];
    const contextWithAgentBoundaries = deltaEventsForAgent.length > 0
      ? [...context, ...deltaEventsForAgent].sort((a, b) => a.idx - b.idx)
      : context;
    const subagentExploreExtraction = message.role === "assistant"
      ? extractSubagentExploreGroups(contextWithAgentBoundaries)
      : null;
    const subagentGroups = subagentExploreExtraction?.subagentGroups ?? [];
    const subagentEventIds = subagentExploreExtraction?.subagentEventIds ?? new Set<string>();

    let cleanedContent = message.role === "assistant"
      ? sanitizeAssistantVisibleText(message.content)
      : message.content;
    if (message.role === "assistant" && message.content.length > 0) {
      cleanedContent = message.content
        .replace(SUBAGENT_SUMMARY_REGEX, "")
        .replace(MAIN_SUMMARY_REGEX, "")
        .replace(MAIN_SUMMARY_START_MARKER, "")
        .replace(MAIN_SUMMARY_END_MARKER, "")
        .trim();
      cleanedContent = sanitizeAssistantVisibleText(cleanedContent);
    }

    const nonSubagentContext = message.role === "assistant"
      ? context.filter((event) => !subagentEventIds.has(event.id))
      : context;

    const allBashRuns = message.role === "assistant" ? extractBashRuns(nonSubagentContext) : [];
    const exploreLikeBashEventIds = new Set<string>();
    if (message.role === "assistant") {
      for (const run of allBashRuns) {
        const command = nonSubagentContext.find((event) => run.eventIds.has(event.id) && event.type === "tool.started");
        if (command && isExploreLikeBashEvent(command)) {
          run.eventIds.forEach((id) => exploreLikeBashEventIds.add(id));
        }
      }
    }

    const bashRuns = allBashRuns.filter((run) => {
      for (const id of run.eventIds) {
        if (exploreLikeBashEventIds.has(id)) return false;
      }
      return true;
    });

    const bashRunEventIds = new Set<string>();
    const permissionToolNameByRequestId = new Map<string, string>();
    if (message.role === "assistant") {
      for (const event of nonSubagentContext) {
        if (event.type !== "permission.requested") {
          continue;
        }
        const requestId = payloadStringOrNull(event.payload.requestId);
        const toolName = payloadStringOrNull(event.payload.toolName);
        if (!requestId || !toolName) {
          continue;
        }
        permissionToolNameByRequestId.set(requestId, toolName.toLowerCase());
      }
      for (const run of bashRuns) {
        run.eventIds.forEach((eventId) => bashRunEventIds.add(eventId));
      }
    }

    const nonBashContext = message.role === "assistant"
      ? nonSubagentContext.filter((event) => {
        if (exploreLikeBashEventIds.has(event.id)) {
          return true;
        }
        if (isBashToolEvent(event) || bashRunEventIds.has(event.id)) {
          return false;
        }
        if (bashRuns.length > 0 && (event.type === "permission.requested" || event.type === "permission.resolved")) {
          if (event.type === "permission.requested") {
            const toolName = payloadStringOrNull(event.payload.toolName)?.toLowerCase();
            if (toolName === "bash") {
              return false;
            }
          } else {
            const requestId = payloadStringOrNull(event.payload.requestId);
            if (requestId && permissionToolNameByRequestId.get(requestId) === "bash") {
              return false;
            }
          }
        }
        return true;
      })
      : nonSubagentContext;

    const exploreActivityGroups = subagentExploreExtraction?.exploreActivityGroups ?? [];
    const claimedContextEventIds = subagentExploreExtraction?.claimedContextEventIds ?? new Set<string>();
    const overlapUnclaimedEventIds = subagentExploreExtraction?.overlapUnclaimedEventIds ?? new Set<string>();
    if (message.role === "assistant") {
      pushRenderDebug({
        source: "useWorkspaceTimeline",
        event: "subagentExploreExtraction",
        messageId: message.id,
        details: {
          subagentGroupCount: subagentGroups.length,
          subagentEventIds: [...subagentEventIds],
          exploreGroupCount: exploreActivityGroups.length,
          exploreEventIds: exploreActivityGroups.flatMap((group) => group.eventIds),
          overlapUnclaimedEventIds: [...overlapUnclaimedEventIds],
        },
      });
    }
    const failedReadToolUseIds = new Set<string>();
    if (message.role === "assistant") {
      for (const event of context) {
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
    }

    const failedReadEventIds = new Set<string>();
    if (message.role === "assistant" && failedReadToolUseIds.size > 0) {
      for (const event of context) {
        if (event.type === "tool.finished") {
          const summary = payloadStringOrNull(event.payload.summary)?.trim().toLowerCase() ?? "";
          if (summary.startsWith("failed to read")) {
            failedReadEventIds.add(event.id);
            continue;
          }
        }

        if (event.type !== "tool.started" && event.type !== "tool.output") {
          continue;
        }

        const runId = payloadStringOrNull(event.payload.toolUseId);
        if (runId && failedReadToolUseIds.has(runId)) {
          failedReadEventIds.add(event.id);
        }
      }
    }

    const activityContext = message.role === "assistant"
      ? context.filter((event) => !claimedContextEventIds.has(event.id) && !failedReadEventIds.has(event.id))
      : context;
    overlapUnclaimedEventIds.forEach((eventId) => assignedToolEventIds.add(eventId));

    if (message.role === "assistant") {
      for (const run of bashRuns) {
        run.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
      }
    }

    const editedRuns = message.role === "assistant"
      ? extractEditedRuns(nonBashContext, context)
          .filter((run) => !run.changedFiles.every((filePath) => isPlanFilePath(filePath)))
      : [];

    if (message.role === "assistant") {
      for (const run of editedRuns) {
        run.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
      }
      if (editedRuns.some((run) => run.diffKind !== "none")) {
        hasEditedRunsWithDiffs = true;
      }
      for (const group of subagentGroups) {
        group.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
      }
      for (const group of exploreActivityGroups) {
        group.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
      }
    }

    const hasInlineActivityCards =
      bashRuns.length > 0
      || editedRuns.length > 0
      || subagentGroups.length > 0
      || exploreActivityGroups.length > 0
      || !!planFileOutput;

    if (message.role === "assistant" && activityContext.length > 0 && !hasInlineActivityCards) {
      const steps = buildActivitySteps(activityContext);
      const contextTimestamp = parseTimestamp(activityContext[0]?.createdAt ?? message.createdAt);
      if (steps.length > 0) {
        activityContext.forEach((event) => assignedToolEventIds.add(event.id));
        sortable.push({
          item: {
            kind: "activity",
            messageId: message.id,
            durationSeconds: computeDurationSecondsFromEvents(activityContext),
            introText: buildActivityIntroText(message.content),
            steps,
            defaultExpanded: isStreamingMessage,
          },
          anchorIdx,
          timestamp: contextTimestamp,
          rank: 2,
          stableOrder: message.seq,
        });
      }
    }

    if (message.role === "assistant" && activityContext.length > 0 && bashRuns.length > 0) {
      activityContext.forEach((event) => assignedToolEventIds.add(event.id));
    }

    if (message.role === "assistant" && (bashRuns.length > 0 || editedRuns.length > 0 || exploreActivityGroups.length > 0 || subagentGroups.length > 0 || !!planFileOutput)) {
      const hasInlineSubagentRuns = subagentGroups.length > 0;
      const inlineInserts = buildInlineInserts(bashRuns, editedRuns, subagentGroups, exploreActivityGroups, planFileOutput);
      const messageDeltaEvents = assistantDeltaEventsByMessageId.get(message.id) ?? [];
      const hasDirectMessageAnchor = firstMessageEventIdxById.has(message.id) || completedEventIdxByMessageId.has(message.id);
      const forcedInlineAnchorIdx = hasDirectMessageAnchor ? undefined : anchorIdx;
      const planResult = filterPostPlanDeltaEvents(messageDeltaEvents, inlineInserts, cleanedContent);
      const effectiveDeltaEvents = planResult.effectiveDeltaEvents;
      cleanedContent = planResult.cleanedContent;
      const segmentBuckets = buildSegmentBuckets(inlineInserts, effectiveDeltaEvents);

      const totalSegmentLength = segmentBuckets.reduce((sum, bucket) => sum + bucket.content.length, 0);
      const hasSegmentContent = totalSegmentLength > 0;
      const hasAnyMessageDelta = messageDeltaEvents.length > 0;
      const hasLowerMessageDeltaCoverage = hasAnyMessageDelta && !firstMessageEventIdxById.has(message.id);
      const deltasCoverageRatio = cleanedContent.length > 0 ? totalSegmentLength / cleanedContent.length : 1;
      const deltasSignificantlyIncomplete = hasSegmentContent && (deltasCoverageRatio < 0.9 || hasLowerMessageDeltaCoverage);
      if (deltasSignificantlyIncomplete) {
        hasIncompleteCoverage = true;
      }

      applySubagentContentCleaning(
        segmentBuckets,
        cleanedContent,
        hasInlineSubagentRuns,
        subagentGroups,
        SUBAGENT_SUMMARY_REGEX,
        MAIN_SUMMARY_REGEX,
        MAIN_SUMMARY_START_MARKER,
        MAIN_SUMMARY_END_MARKER,
        totalSegmentLength,
        deltasSignificantlyIncomplete,
        inlineInserts,
        anchorIdx,
        timestamp,
      );

      rebalanceSentenceAwareSegmentBuckets(segmentBuckets, inlineInserts);
      mergeSmallSegments(segmentBuckets, inlineInserts);
      fixPunctuationSplits(segmentBuckets);

      const stableOffset = { value: 0 };
      processInlineInsertLoop(
        segmentBuckets,
        inlineInserts,
        sortable,
        message,
        renderHint,
        isCompleted,
        nonBashContext,
        anchorIdx,
        timestamp,
        stableOffset,
        forcedInlineAnchorIdx,
      );

      continue;
    }

    sortable.push({
      item: {
        kind: "message",
        message,
        context: nonBashContext,
        renderHint,
        rawFileLanguage,
        isCompleted,
      },
      anchorIdx,
      timestamp,
      rank: message.role === "assistant" ? 3 : message.role === "user" ? 1 : 4,
      stableOrder: message.seq,
    });
  }

  for (const planFileOutput of planFileOutputByMessageId.values()) {
    sortable.push({
      item: {
        kind: "plan-file-output",
        id: planFileOutput.id,
        messageId: planFileOutput.messageId,
        content: planFileOutput.content,
        filePath: planFileOutput.filePath,
        createdAt: planFileOutput.createdAt,
      },
      anchorIdx: planFileOutput.idx,
      timestamp: parseTimestamp(planFileOutput.createdAt),
      rank: 3,
      stableOrder: planFileOutput.idx + 0.0005,
    });
  }

  processOrphanSubagentGroups(semanticContextEvents, assignedToolEventIds, chatTerminated, sortable);
  processOrphanExploreGroups(semanticContextEvents, assignedToolEventIds, chatTerminated, sortable);

  const orphanResult = processOrphanToolEvents(
    inlineToolEvents,
    assignedToolEventIds,
    hasEditedRunsWithDiffs,
    sortedMessages,
    sortable,
    selectedThreadId,
    refs,
  );
  if (orphanResult.hasIncompleteCoverage) {
    hasIncompleteCoverage = true;
  }

  hasIncompleteCoverage = processUnassignedSemanticEvents(
    semanticContextEvents,
    assignedToolEventIds,
    assistantContextById,
    assistantDeltaEventsByMessageId,
    sortedMessages,
    messageAnchorIdxById,
    completedMessageIds,
    sortedMessages,
    hasIncompleteCoverage,
    semanticHydrationInProgress,
    selectedThreadId,
    sortable,
  );

  processFailedEvents(inlineToolEvents, assignedToolEventIds, sortable);
  rebalanceMultiFileEditAnnouncements(sortable);
  rebalanceTrailingSingleEditAnnouncements(sortable);

  const items = normalizeTrailingEditAnnouncementOrder(sortable
    .sort((a, b) => {
      if (a.anchorIdx !== b.anchorIdx) {
        return a.anchorIdx - b.anchorIdx;
      }
      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }
      if (a.stableOrder !== b.stableOrder) {
        return a.stableOrder - b.stableOrder;
      }
      const aTime = a.timestamp ?? MAX_ORDER_INDEX;
      const bTime = b.timestamp ?? MAX_ORDER_INDEX;
      return aTime - bTime;
    })
    .map((entry) => entry.item));

  const oldestRenderable = items[0] ?? null;
  const oldestRenderableKey = oldestRenderable ? getTimelineItemKey(oldestRenderable) : null;
  const oldestRenderableKind = oldestRenderable?.kind ?? null;
  const oldestRenderableMessageId = oldestRenderable?.kind === "message"
    ? oldestRenderable.message.id
    : oldestRenderable?.kind === "plan-file-output"
      ? oldestRenderable.messageId
      : null;
  const oldestRenderableHydrationPending = semanticHydrationInProgress
    && oldestRenderableMessageId != null
    && oldestRenderableMessageId === oldestAssistantMessageId
    && hasIncompleteCoverage;

  const summary: ChatTimelineSummary = {
    oldestRenderableKey,
    oldestRenderableKind,
    oldestRenderableMessageId,
    oldestRenderableHydrationPending,
    headIdentityStable: true,
  };

  return {
    items,
    summary,
    hasIncompleteCoverage,
  };
}

function getTimelineItemKey(item: ChatTimelineItem): string {
  switch (item.kind) {
    case "message":
      return `message:${item.message.id}`;
    case "plan-file-output":
    case "edited-diff":
    case "explore-activity":
    case "subagent-activity":
    case "error":
      return `${item.kind}:${item.id}`;
    case "tool":
      return `tool:${item.id}`;
    case "activity":
      return `activity:${item.messageId}`;
  }
}
