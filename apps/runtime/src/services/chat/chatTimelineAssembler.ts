import type { ChatEvent, ChatMessage, ChatTimelineItem, ChatTimelineSummary } from "@codesymphony/shared-types";
import { appendRuntimeDebugLog } from "../../routes/debug.js";
import { INLINE_TOOL_EVENT_TYPES, MAX_ORDER_INDEX } from "../../../../web/src/pages/workspace/constants.ts";
import { extractBashRuns } from "../../../../web/src/pages/workspace/bashUtils.ts";
import { extractEditedRuns } from "../../../../web/src/pages/workspace/editUtils.ts";
import { extractExploreActivityGroups } from "../../../../web/src/pages/workspace/exploreUtils.ts";
import { extractSubagentGroups } from "../../../../web/src/pages/workspace/subagentUtils.ts";
import {
  buildActivityIntroText,
  buildActivitySteps,
  computeDurationSecondsFromEvents,
  getCompletedMessageId,
  getEventMessageId,
  hasUnclosedCodeFence,
  isBashToolEvent,
  isClaudePlanFilePayload,
  isExploreLikeBashEvent,
  isLikelyDiffContent,
  isPlanFilePath,
  isReadToolEvent,
  isRecord,
  isWorktreeDiffEvent,
  parseTimestamp,
  payloadStringOrNull,
  promptLooksLikeFileRead,
} from "../../../../web/src/pages/workspace/eventUtils.ts";
import { computeMessageAnchorIdxById } from "../../../../web/src/pages/workspace/hooks/workspace-timeline/timelineAnchorUtils.ts";
import { buildThinkingRounds, mergeThinkingRounds, insertThinkingItems } from "../../../../web/src/pages/workspace/hooks/workspace-timeline/timelineThinkingUtils.ts";
import {
  buildInlineInserts,
  buildSegmentBuckets,
  applySubagentContentCleaning,
  mergeSmallSegments,
  fixPunctuationSplits,
  processInlineInsertLoop,
  filterPostPlanDeltaEvents,
} from "../../../../web/src/pages/workspace/hooks/workspace-timeline/timelineInlineInserts.ts";
import {
  processOrphanSubagentGroups,
  processOrphanExploreGroups,
  processOrphanToolEvents,
  processUnassignedSemanticEvents,
  processFailedEvents,
} from "../../../../web/src/pages/workspace/hooks/workspace-timeline/timelineOrphans.ts";

const SUBAGENT_SUMMARY_REGEX = /###subagent summary(?:\s+start)?\n?([\s\S]*?)###subagent summary end\n?/g;
const MAIN_SUMMARY_REGEX = /###main(?:\s+agent)? summary(?:\s+start)?\n?[\s\S]*?###main(?:\s+agent)? summary end\n?/g;
const MAIN_SUMMARY_START_MARKER = /###main(?:\s+agent)? summary(?:\s+start)?\n?/g;
const MAIN_SUMMARY_END_MARKER = /###main(?:\s+agent)? summary end\n?/g;

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

function logTimelineAssembly(message: string, data: Record<string, unknown>): void {
  appendRuntimeDebugLog({
    source: "chatTimelineAssembler",
    message,
    data,
  });
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

  const thinkingRoundsByMessageId = buildThinkingRounds(orderedEventsByIdx);

  const planFileOutputByMessageId = new Map<string, PlanFileOutput>();
  for (const event of orderedEventsByIdx) {
    if (event.type !== "plan.created") {
      continue;
    }

    const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
    if (messageId.length === 0 || !isClaudePlanFilePayload(event.payload)) {
      continue;
    }

    let content = typeof event.payload.content === "string" ? event.payload.content : "";
    let filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "plan.md";
    if (content.trim().length === 0) {
      continue;
    }

    if (event.payload.source === "streaming_fallback" && !isPlanFilePath(filePath)) {
      const realWrite = orderedEventsByIdx.find((candidate) =>
        candidate.idx > event.idx
        && candidate.type === "tool.finished"
        && isPlanFilePath(
          payloadStringOrNull(candidate.payload.editTarget)
            ?? payloadStringOrNull(candidate.payload.file_path)
            ?? "",
        )
      );
      if (realWrite) {
        const toolInput = isRecord(realWrite.payload.toolInput) ? realWrite.payload.toolInput : null;
        const realContent = toolInput ? payloadStringOrNull(toolInput.content) : null;
        const realPath = payloadStringOrNull(realWrite.payload.editTarget)
          ?? payloadStringOrNull(realWrite.payload.file_path)
          ?? filePath;
        if (realContent && realContent.trim().length > 0) {
          planFileOutputByMessageId.set(messageId, {
            id: realWrite.id,
            messageId,
            content: realContent,
            filePath: realPath,
            idx: realWrite.idx,
            createdAt: realWrite.createdAt,
          });
          continue;
        }
      }
    }

    planFileOutputByMessageId.set(messageId, {
      id: event.id,
      messageId,
      content,
      filePath,
      idx: event.idx,
      createdAt: event.createdAt,
    });
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
    || event.type === "thinking.delta"
  );
  const assistantDeltaEventsByMessageId = new Map<string, ChatEvent[]>();
  const thinkingDeltaEventsByMessageId = new Map<string, ChatEvent[]>();
  for (const event of orderedEventsByIdx) {
    if (event.type === "thinking.delta") {
      const thinkingMessageId = getEventMessageId(event);
      if (thinkingMessageId) {
        const existingThinking = thinkingDeltaEventsByMessageId.get(thinkingMessageId) ?? [];
        existingThinking.push(event);
        thinkingDeltaEventsByMessageId.set(thinkingMessageId, existingThinking);
      }
      continue;
    }

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
    const rawRounds = message.role === "assistant" ? thinkingRoundsByMessageId.get(message.id) ?? [] : [];
    const hasThinkingRounds = rawRounds.length > 0;
    const oldestAssistantMissingRichContext =
      message.role === "assistant"
      && oldestAssistantMessageId != null
      && message.id === oldestAssistantMessageId
      && message.content.trim().length > 0
      && !hasToolEventsInContext
      && !hasThinkingRounds
      && !hasMessageDelta;
    if (oldestAssistantMissingRichContext) {
      hasIncompleteCoverage = true;
    }

    if (
      message.role === "assistant"
      && !hasToolEventsInContext
      && !hasThinkingRounds
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

    let renderHint: ChatTimelineItem["renderHint"];
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
    const thinkingEventsForAgent = message.role === "assistant"
      ? (thinkingDeltaEventsByMessageId.get(message.id) ?? [])
      : [];
    const contextWithAgentBoundaries = (deltaEventsForAgent.length > 0 || thinkingEventsForAgent.length > 0)
      ? [...context, ...thinkingEventsForAgent, ...deltaEventsForAgent].sort((a, b) => a.idx - b.idx)
      : context;
    const subagentGroups = message.role === "assistant"
      ? extractSubagentGroups(contextWithAgentBoundaries)
      : [];
    const subagentEventIds = new Set<string>();
    for (const group of subagentGroups) {
      group.eventIds.forEach((id) => subagentEventIds.add(id));
    }

    let cleanedContent = message.content;
    if (message.role === "assistant" && message.content.length > 0) {
      cleanedContent = message.content
        .replace(SUBAGENT_SUMMARY_REGEX, "")
        .replace(MAIN_SUMMARY_REGEX, "")
        .replace(MAIN_SUMMARY_START_MARKER, "")
        .replace(MAIN_SUMMARY_END_MARKER, "")
        .trim();
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

    const exploreActivityGroups = message.role === "assistant"
      ? extractExploreActivityGroups(
        contextWithAgentBoundaries.filter((event) => !subagentEventIds.has(event.id)),
      )
      : [];
    const agentEventIds = new Set<string>();
    for (const group of subagentGroups) {
      group.eventIds.forEach((id) => agentEventIds.add(id));
    }
    for (const group of exploreActivityGroups) {
      group.eventIds.forEach((id) => agentEventIds.add(id));
    }
    const activityContext = message.role === "assistant"
      ? context.filter((event) => !agentEventIds.has(event.id))
      : context;

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
      if (subagentGroups.length > 0 || exploreActivityGroups.length > 0) {
        logTimelineAssembly("subagentExploreExtraction", {
          messageId: message.id,
          subagentGroups: subagentGroups.map((group) => ({
            id: group.id,
            toolUseId: group.toolUseId,
            descriptionLen: group.description.trim().length,
            steps: group.steps.length,
            eventIds: [...group.eventIds],
          })),
          exploreActivityGroups: exploreActivityGroups.map((group) => ({
            id: group.id,
            status: group.status,
            entries: group.entries.length,
            eventIds: [...group.eventIds],
          })),
          claimedEventIds: [...subagentEventIds],
        });
      }
    }

    if (message.role === "assistant" && activityContext.length > 0 && bashRuns.length === 0) {
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

    if (message.role === "assistant") {
      const mergedRounds = mergeThinkingRounds(
        rawRounds,
        bashRuns,
        editedRuns,
        subagentGroups,
        exploreActivityGroups,
        planFileOutput,
      );
      insertThinkingItems(
        mergedRounds,
        message.id,
        message.seq,
        isCompleted,
        isStreamingMessage,
        (assistantDeltaEventsByMessageId.get(message.id)?.length ?? 0) > 0,
        planFileOutput,
        orderedEventsByIdx,
        timestamp,
        sortable,
      );
    }

    if (message.role === "assistant" && (bashRuns.length > 0 || editedRuns.length > 0 || exploreActivityGroups.length > 0 || subagentGroups.length > 0 || !!planFileOutput)) {
      const hasInlineSubagentRuns = subagentGroups.length > 0;
      const inlineInserts = buildInlineInserts(bashRuns, editedRuns, subagentGroups, exploreActivityGroups, planFileOutput);
      logTimelineAssembly("inlineInsertsBuilt", {
        messageId: message.id,
        inserts: inlineInserts.map((insert) => ({
          kind: insert.kind,
          id: insert.id,
          startIdx: insert.startIdx,
          anchorIdx: insert.anchorIdx,
        })),
      });
      const messageDeltaEvents = assistantDeltaEventsByMessageId.get(message.id) ?? [];
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

      mergeSmallSegments(segmentBuckets);
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
    thinkingDeltaEventsByMessageId,
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

  const items = sortable
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
    .map((entry) => entry.item);

  logTimelineAssembly("finalTimelineItems", {
    count: items.length,
    signatures: items.map(getTimelineItemKey),
  });

  const oldestRenderable = items[0] ?? null;
  const oldestRenderableKey = oldestRenderable ? getTimelineItemKey(oldestRenderable) : null;
  const oldestRenderableKind = oldestRenderable?.kind ?? null;
  const oldestRenderableMessageId = oldestRenderable?.kind === "message"
    ? oldestRenderable.message.id
    : oldestRenderable?.kind === "thinking"
      ? oldestRenderable.messageId
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
    case "bash-command":
    case "edited-diff":
    case "explore-activity":
    case "subagent-activity":
    case "thinking":
    case "error":
      return `${item.kind}:${item.id}`;
    case "tool":
      return `tool:${item.event.id}`;
    case "activity":
      return `activity:${item.messageId}`;
  }
}
