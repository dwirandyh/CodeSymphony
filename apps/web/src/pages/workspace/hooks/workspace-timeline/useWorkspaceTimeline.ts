import { useMemo, useRef } from "react";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { AssistantRenderHint } from "../../../../components/workspace/chat-message-list";
import { INLINE_TOOL_EVENT_TYPES, MAX_ORDER_INDEX, SENTENCE_BOUNDARY_PATTERN } from "../../constants";
import { extractBashRuns } from "../../bashUtils";
import { extractEditedRuns } from "../../editUtils";
import { extractExploreActivityGroups } from "../../exploreUtils";
import { extractSubagentGroups } from "../../subagentUtils";
import {
  buildActivityIntroText,
  buildActivitySteps,
  computeDurationSecondsFromEvents,
  getCompletedMessageId,
  getEventMessageId,
  hasUnclosedCodeFence,
  isBashToolEvent,
  isExploreLikeBashEvent,
  isClaudePlanFilePayload,
  isPlanFilePath,
  isLikelyDiffContent,
  isReadToolEvent,
  isRecord,
  isWorktreeDiffEvent,
  parseTimestamp,
  payloadStringOrNull,
  promptLooksLikeFileRead,
} from "../../eventUtils";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import { debugLog } from "../../../../lib/debugLog";
import type {
  TimelineRefs,
  WorkspaceTimelineResult,
  UseWorkspaceTimelineOptions,
  SortableEntry,
  PlanFileOutput,
} from "./useWorkspaceTimeline.types";
import { computeMessageAnchorIdxById } from "./timelineAnchorUtils";
import { buildThinkingRounds, mergeThinkingRounds, insertThinkingItems } from "./timelineThinkingUtils";
import {
  buildInlineInserts,
  buildSegmentBuckets,
  applySubagentContentCleaning,
  mergeSmallSegments,
  fixPunctuationSplits,
  processInlineInsertLoop,
  filterPostPlanDeltaEvents,
} from "./timelineInlineInserts";
import {
  processOrphanSubagentGroups,
  processOrphanExploreGroups,
  processOrphanToolEvents,
  processUnassignedSemanticEvents,
  processFailedEvents,
} from "./timelineOrphans";

function getTimelineItemStableKey(item: { kind: string;[key: string]: unknown }): string {
  switch (item.kind) {
    case "message":
      return `message:${(item as unknown as { message: { id: string } }).message.id}`;
    case "plan-file-output":
      return `plan-file-output:${item.id}`;
    case "activity":
      return `activity:${item.messageId}`;
    case "tool":
      return `tool:${item.id}`;
    case "edited-diff":
      return `edited-diff:${item.id}`;
    case "subagent-activity":
      return `subagent-activity:${item.id}`;
    case "explore-activity":
      return `explore-activity:${item.id}`;
    case "thinking":
      return `thinking:${item.id}`;
    case "error":
      return `error:${item.id}`;
    default:
      return "unknown";
  }
}

const SUBAGENT_SUMMARY_REGEX = /###subagent summary(?:\s+start)?\n?([\s\S]*?)###subagent summary end\n?/g;
const MAIN_SUMMARY_REGEX = /###main(?:\s+agent)? summary(?:\s+start)?\n?[\s\S]*?###main(?:\s+agent)? summary end\n?/g;
const MAIN_SUMMARY_START_MARKER = /###main(?:\s+agent)? summary(?:\s+start)?\n?/g;
const MAIN_SUMMARY_END_MARKER = /###main(?:\s+agent)? summary end\n?/g;

export function useWorkspaceTimeline(
  messages: ChatMessage[],
  events: ChatEvent[],
  selectedThreadId: string | null,
  refs: TimelineRefs,
  options?: UseWorkspaceTimelineOptions,
): WorkspaceTimelineResult {
  const prevFingerprintRef = useRef<{
    messageCount: number;
    eventCount: number;
    lastEventIdx: number;
    firstEventIdx: number;
    threadId: string | null;
    semanticHydrationInProgress: boolean;
  } | null>(null);
  const prevInputCountsRef = useRef<{ messageCount: number; eventCount: number } | null>(null);
  const prevResultRef = useRef<WorkspaceTimelineResult>({
    items: [],
    hasIncompleteCoverage: false,
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
  });

  return useMemo<WorkspaceTimelineResult>(() => {
    const semanticHydrationInProgress = options?.semanticHydrationInProgress === true;
    const disabled = options?.disabled === true;
    const lastEventIdx = events.length > 0 ? events[events.length - 1].idx : -1;
    const firstEventIdx = events.length > 0 ? events[0].idx : -1;
    const fingerprint = {
      messageCount: messages.length,
      eventCount: events.length,
      lastEventIdx,
      firstEventIdx,
      threadId: selectedThreadId,
      semanticHydrationInProgress,
    };
    const prev = prevFingerprintRef.current;
    if (
      prev !== null &&
      prev.messageCount === fingerprint.messageCount &&
      prev.eventCount === fingerprint.eventCount &&
      prev.lastEventIdx === fingerprint.lastEventIdx &&
      prev.firstEventIdx === fingerprint.firstEventIdx &&
      prev.threadId === fingerprint.threadId &&
      prev.semanticHydrationInProgress === fingerprint.semanticHydrationInProgress &&
      prevResultRef.current.items.length > 0
    ) {
      return prevResultRef.current;
    }

    const sortedMessages = [...messages].sort((a, b) => a.seq - b.seq);

    if (disabled) {
      const disabledResult: WorkspaceTimelineResult = {
        items: [],
        hasIncompleteCoverage: false,
        summary: {
          oldestRenderableKey: null,
          oldestRenderableKind: null,
          oldestRenderableMessageId: null,
          oldestRenderableHydrationPending: false,
          headIdentityStable: true,
        },
      };
      prevFingerprintRef.current = fingerprint;
      prevInputCountsRef.current = {
        messageCount: messages.length,
        eventCount: events.length,
      };
      prevResultRef.current = disabledResult;
      return disabledResult;
    }

    const orderedEventsByIdx = [...events].sort((a, b) => a.idx - b.idx);

    const localStickyIds = new Set(refs.stickyRawFallbackMessageIds);

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
      if (messageId.length === 0) {
        continue;
      }

      if (!isClaudePlanFilePayload(event.payload)) {
        continue;
      }

      let content = typeof event.payload.content === "string" ? event.payload.content : "";
      let filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "plan.md";
      if (content.trim().length === 0) {
        continue;
      }

      if (event.payload.source === "streaming_fallback" && !isPlanFilePath(filePath)) {
        const realWrite = orderedEventsByIdx.find(e =>
          e.idx > event.idx
          && e.type === "tool.finished"
          && isPlanFilePath(
            payloadStringOrNull(e.payload.editTarget)
            ?? payloadStringOrNull(e.payload.file_path)
            ?? "",
          )
        );
        if (realWrite) {
          const toolInput = isRecord(realWrite.payload.toolInput)
            ? realWrite.payload.toolInput
            : null;
          const realContent = toolInput
            ? payloadStringOrNull(toolInput.content)
            : null;
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
      || event.type === "thinking.delta",
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
      pushRenderDebug({
        source: "WorkspacePage",
        event: "activityContextCollected",
        messageId: message.id,
        details: {
          lowerBoundaryIdx,
          upperBoundaryIdx,
          contextSize: context.length,
          contextEvents: context.map((event) => ({
            id: event.id,
            idx: event.idx,
            type: event.type,
          })),
        },
      });
      if (Number.isFinite(upperBoundaryIdx)) {
        previousAssistantBoundaryIdx = Math.max(previousAssistantBoundaryIdx, upperBoundaryIdx);
      }
    }

    const sortable: SortableEntry[] = [];
    const assignedToolEventIds = new Set<string>();
    let hasEditedRunsWithDiffs = false;
    let hasIncompleteCoverage = false;
    const oldestAssistantMessageId = sortedMessages.find((message) => message.role === "assistant")?.id ?? null;

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
        message.role === "assistant" &&
        !!planFileOutput &&
        message.content.trim().length > 0 &&
        message.content.trim() === planFileOutput.content.trim();

      const hasToolEventsInContext = message.role === "assistant"
        && (assistantContextById.get(message.id)?.length ?? 0) > 0;

      const hasThinkingRounds = (thinkingRoundsByMessageId.get(message.id)?.length ?? 0) > 0;
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
        message.role === "assistant" &&
        !hasToolEventsInContext &&
        !hasThinkingRounds &&
        (shouldSkipMessageBecausePlanCard || (message.content.trim().length === 0 && !isCompleted && !hasMessageDelta))
      ) {
        continue;
      }

      const hasUnclosedFence = message.role === "assistant" ? hasUnclosedCodeFence(message.content) : false;
      if (message.role === "assistant" && !isCompleted && hasUnclosedFence && !isReadResponseContext) {
        localStickyIds.add(message.id);
      }
      if (message.role === "assistant" && isCompleted) {
        localStickyIds.delete(message.id);
      }
      const shouldRenderRawFallback =
        message.role === "assistant"
        && !isCompleted
        && !isReadResponseContext
        && localStickyIds.has(message.id);
      const isStreamingMessage = message.role === "assistant" && refs.streamingMessageIds.has(message.id) && !isCompleted;
      if (message.role === "assistant") {
        const decisionSignature = [
          isReadResponseContext ? "read:1" : "read:0",
          shouldRenderRawFallback ? "fallback:1" : "fallback:0",
          `ctx:${context.length}`,
          `len:${message.content.length}`,
        ].join("|");
        const previousSignature = refs.renderDecisionByMessageId.get(message.id);
        if (decisionSignature !== previousSignature) {
          refs.renderDecisionByMessageId.set(message.id, decisionSignature);
          pushRenderDebug({
            source: "WorkspacePage",
            event: "rawFileDecision",
            messageId: message.id,
            details: {
              isReadResponseContext,
              shouldRenderRawFallback,
              contextCount: context.length,
              contentLength: message.content.length,
            },
          });
        }
      }
      const renderHint: AssistantRenderHint | undefined =
        message.role === "assistant"
          ? (() => {
            if (isLikelyDiffContent(message.content)) {
              return "diff";
            }

            if (shouldRenderRawFallback) {
              if (isStreamingMessage) {
                return "markdown";
              }
              return "raw-fallback";
            }

            return "markdown";
          })()
          : undefined;

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
      const subagentSummaryRegex = SUBAGENT_SUMMARY_REGEX;
      const mainSummaryStartMarker = MAIN_SUMMARY_START_MARKER;
      const mainSummaryEndMarker = MAIN_SUMMARY_END_MARKER;

      let cleanedContent = message.content;

      if (subagentGroups.length > 0 && message.content.length > 0) {
        const subagentSummaryMatch = subagentSummaryRegex.exec(message.content);
        if (subagentSummaryMatch) {
          const extractedSummary = subagentSummaryMatch[1].trim();
          if (extractedSummary) {
            for (const group of subagentGroups) {
              if (!group.lastMessage || group.lastMessage.length < 100) {
                group.lastMessage = extractedSummary;
              }
            }
          }
        }

        subagentSummaryRegex.lastIndex = 0;
        cleanedContent = message.content
          .replace(subagentSummaryRegex, "")
          .replace(MAIN_SUMMARY_REGEX, "")
          .replace(mainSummaryStartMarker, "")
          .replace(mainSummaryEndMarker, "")
          .trim();
      }

      if (message.role === "assistant" && message.content.length > 0) {
        subagentSummaryRegex.lastIndex = 0;
        cleanedContent = message.content
          .replace(subagentSummaryRegex, "")
          .replace(MAIN_SUMMARY_REGEX, "")
          .replace(mainSummaryStartMarker, "")
          .replace(mainSummaryEndMarker, "")
          .trim();
      }
      const nonSubagentContext = message.role === "assistant"
        ? context.filter((event) => !agentEventIds.has(event.id))
        : context;

      const allBashRuns = message.role === "assistant" ? extractBashRuns(nonSubagentContext) : [];
      const exploreLikeBashEventIds = new Set<string>();
      if (message.role === "assistant") {
        for (const run of allBashRuns) {
          const command = nonSubagentContext.find((e) => run.eventIds.has(e.id) && e.type === "tool.started");
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
      const activityContext = message.role === "assistant"
        ? nonBashContext.filter((event) => !isWorktreeDiffEvent(event))
        : nonBashContext;
      if (message.role === "assistant") {
        for (const run of bashRuns) {
          run.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
      }
      const editedRuns = message.role === "assistant"
        ? extractEditedRuns(nonBashContext, context)
          .filter((run) => !run.changedFiles.every((f) => isPlanFilePath(f)))
        : [];
      if (message.role === "assistant") {
        for (const run of editedRuns) {
          run.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
        if (editedRuns.some((r) => r.diffKind !== "none")) {
          hasEditedRunsWithDiffs = true;
        }
        for (const group of subagentGroups) {
          group.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
        for (const group of exploreActivityGroups) {
          group.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
      }

      if (message.role === "assistant" && activityContext.length > 0 && bashRuns.length === 0) {
        const steps = buildActivitySteps(activityContext);
        const contextTimestamp = parseTimestamp(activityContext[0]?.createdAt ?? message.createdAt);
        pushRenderDebug({
          source: "WorkspacePage",
          event: "activityStepsBuilt",
          messageId: message.id,
          details: {
            contextSize: activityContext.length,
            stepSize: steps.length,
            steps,
          },
        });
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
        const rawRounds = thinkingRoundsByMessageId.get(message.id) ?? [];
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

      if (
        message.role === "assistant"
        && (bashRuns.length > 0 || editedRuns.length > 0 || subagentGroups.length > 0 || exploreActivityGroups.length > 0 || !!planFileOutput)
      ) {
        const hasInlineSubagentRuns = subagentGroups.length > 0;

        const inlineInserts = buildInlineInserts(
          bashRuns,
          editedRuns,
          subagentGroups,
          exploreActivityGroups,
          planFileOutput,
        );

        const messageDeltaEvents = assistantDeltaEventsByMessageId.get(message.id) ?? [];

        const planResult = filterPostPlanDeltaEvents(messageDeltaEvents, inlineInserts, cleanedContent);
        const effectiveDeltaEvents = planResult.effectiveDeltaEvents;
        cleanedContent = planResult.cleanedContent;

        const segmentBuckets = buildSegmentBuckets(inlineInserts, effectiveDeltaEvents);

        const totalSegmentLength = segmentBuckets.reduce((sum, b) => sum + b.content.length, 0);
        const hasSegmentContent = totalSegmentLength > 0;
        const hasAnyMessageDelta = messageDeltaEvents.length > 0;
        const hasLowerMessageDeltaCoverage = hasAnyMessageDelta && !firstMessageEventIdxById.has(message.id);
        const deltasCoverageRatio = cleanedContent.length > 0 ? totalSegmentLength / cleanedContent.length : 1;
        const deltasSignificantlyIncomplete =
          hasSegmentContent && (deltasCoverageRatio < 0.9 || hasLowerMessageDeltaCoverage);
        if (deltasSignificantlyIncomplete) {
          hasIncompleteCoverage = true;
        }

        applySubagentContentCleaning(
          segmentBuckets,
          cleanedContent,
          hasInlineSubagentRuns,
          subagentGroups,
          subagentSummaryRegex,
          MAIN_SUMMARY_REGEX,
          mainSummaryStartMarker,
          mainSummaryEndMarker,
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
          refs,
          selectedThreadId,
        );

        continue;
      }

      sortable.push({
        item: {
          kind: "message",
          message,
          renderHint,
          rawFileLanguage: undefined,
          isCompleted,
          context: nonBashContext,
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

    const chatTerminated = orderedEventsByIdx.some(
      (event) => event.type === "chat.completed" || event.type === "chat.failed",
    );

    processOrphanSubagentGroups(semanticContextEvents, assignedToolEventIds, chatTerminated, sortable);
    processOrphanExploreGroups(semanticContextEvents, assignedToolEventIds, chatTerminated, sortable);

    const orphanResult = processOrphanToolEvents(
      inlineToolEvents,
      assignedToolEventIds,
      hasEditedRunsWithDiffs,
      messages,
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
      messages,
      hasIncompleteCoverage,
      semanticHydrationInProgress,
      selectedThreadId,
      sortable,
    );

    processFailedEvents(inlineToolEvents, assignedToolEventIds, sortable);

    sortable.sort((a, b) => {
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
    });

    refs.stickyRawFallbackMessageIds.clear();
    for (const id of localStickyIds) {
      refs.stickyRawFallbackMessageIds.add(id);
    }

    const result = sortable.map((entry) => entry.item);
    const oldestRenderable = result[0] ?? null;
    const oldestRenderableKey = oldestRenderable != null
      ? getTimelineItemStableKey(oldestRenderable)
      : null;
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
    const previousSummary = prevResultRef.current.summary;
    const headIdentityStable = previousSummary.oldestRenderableKey == null
      || previousSummary.oldestRenderableKey === oldestRenderableKey
      || previousSummary.oldestRenderableMessageId === oldestRenderableMessageId;
    const nextSummary = {
      oldestRenderableKey,
      oldestRenderableKind,
      oldestRenderableMessageId,
      oldestRenderableHydrationPending,
      headIdentityStable,
    };
    const summaryUnchanged = previousSummary.oldestRenderableKey === nextSummary.oldestRenderableKey
      && previousSummary.oldestRenderableKind === nextSummary.oldestRenderableKind
      && previousSummary.oldestRenderableMessageId === nextSummary.oldestRenderableMessageId
      && previousSummary.oldestRenderableHydrationPending === nextSummary.oldestRenderableHydrationPending
      && previousSummary.headIdentityStable === nextSummary.headIdentityStable;
    const timelineResult: WorkspaceTimelineResult = {
      items: result,
      hasIncompleteCoverage,
      summary: summaryUnchanged ? previousSummary : nextSummary,
    };
    const prevResult = prevResultRef.current;
    const prevInputCounts = prevInputCountsRef.current;
    const messagesAdded = messages.length - (prevInputCounts?.messageCount ?? 0);
    const eventsAdded = events.length - (prevInputCounts?.eventCount ?? 0);
    debugLog("useWorkspaceTimeline", "chat.timeline.recomputed", {
      threadId: selectedThreadId,
      messageCount: messages.length,
      eventCount: events.length,
      itemCount: result.length,
      hasIncompleteCoverage,
      semanticHydrationInProgress,
      messagesAdded,
      eventsAdded,
    });
    if (prevResult.hasIncompleteCoverage !== hasIncompleteCoverage) {
      debugLog("useWorkspaceTimeline", "chat.timeline.coverageChanged", {
        threadId: selectedThreadId,
        previousHasIncompleteCoverage: prevResult.hasIncompleteCoverage,
        hasIncompleteCoverage,
        messageCount: messages.length,
        eventCount: events.length,
        itemCount: result.length,
        semanticHydrationInProgress,
      });
    }
    if (prevResult.summary.oldestRenderableKey !== oldestRenderableKey) {
      debugLog("useWorkspaceTimeline", "chat.timeline.oldestRenderableChanged", {
        threadId: selectedThreadId,
        previousOldestRenderableKey: prevResult.summary.oldestRenderableKey,
        previousOldestRenderableKind: prevResult.summary.oldestRenderableKind,
        previousOldestRenderableMessageId: prevResult.summary.oldestRenderableMessageId,
        oldestRenderableKey,
        oldestRenderableKind,
        oldestRenderableMessageId,
        oldestRenderableHydrationPending,
        headIdentityStable,
        messageCount: messages.length,
        eventCount: events.length,
        itemCount: result.length,
      });
    }
    if (messagesAdded === 0 && result.length > prevResult.items.length) {
      debugLog("useWorkspaceTimeline", "chat.timeline.eventsOnlyRenderableGrowth", {
        threadId: selectedThreadId,
        eventCount: events.length,
        itemCount: result.length,
        previousItemCount: prevResult.items.length,
        eventsAdded,
        hasIncompleteCoverage,
        oldestRenderableKey,
        oldestRenderableKind,
        oldestRenderableMessageId,
        oldestRenderableHydrationPending,
        headIdentityStable,
        previousOldestRenderableKey: prevResult.summary.oldestRenderableKey,
        previousOldestRenderableKind: prevResult.summary.oldestRenderableKind,
        previousOldestRenderableMessageId: prevResult.summary.oldestRenderableMessageId,
      });
    }
    prevFingerprintRef.current = fingerprint;
    prevInputCountsRef.current = {
      messageCount: messages.length,
      eventCount: events.length,
    };
    prevResultRef.current = timelineResult;
    return timelineResult;
  }, [messages, events, options?.disabled, options?.semanticHydrationInProgress, selectedThreadId]);
}
