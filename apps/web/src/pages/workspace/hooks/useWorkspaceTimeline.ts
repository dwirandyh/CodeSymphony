import { useMemo } from "react";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type {
  AssistantRenderHint,
  ChatTimelineItem,
} from "../../../components/workspace/ChatMessageList";
import { INLINE_TOOL_EVENT_TYPES, MAX_ORDER_INDEX } from "../constants";
import { extractBashRuns } from "../bashUtils";
import { extractEditedRuns } from "../editUtils";
import { extractExploreActivityGroups } from "../exploreUtils";
import { extractSubagentGroups } from "../subagentUtils";
import {
  buildActivityIntroText,
  buildActivitySteps,
  computeDurationSecondsFromEvents,
  countDiffStats,
  getCompletedMessageId,
  getEventMessageId,
  hasUnclosedCodeFence,
  isBashToolEvent,
  isExploreLikeBashEvent,
  isClaudePlanFilePayload,
  isPlanFilePath,
  isLikelyDiffContent,
  isReadToolEvent,
  isWorktreeDiffEvent,
  parseTimestamp,
  payloadStringArray,
  payloadStringOrNull,
  promptLooksLikeFileRead,
} from "../eventUtils";
import {
  hasSentenceBoundary,
  isSentenceAwareInlineInsertKind,
  shouldDelayFirstInlineInsert,
  splitAtFirstSentenceBoundary,
} from "../textUtils";
import type { BashRun, EditedRun, ExploreActivityGroup, SubagentGroup } from "../types";
import { pushRenderDebug } from "../../../lib/renderDebug";
import { logService } from "../../../lib/logService";

export type TimelineRefs = {
  streamingMessageIds: Set<string>;
  stickyRawFallbackMessageIds: Set<string>;
  renderDecisionByMessageId: Map<string, string>;
  loggedOrphanEventIdsByThread: Map<string, Set<string>>;
};

export function useWorkspaceTimeline(
  messages: ChatMessage[],
  events: ChatEvent[],
  selectedThreadId: string | null,
  refs: TimelineRefs,
): ChatTimelineItem[] {
  return useMemo<ChatTimelineItem[]>(() => {
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

    // Build thinking rounds from events – each round is a contiguous sequence
    // of thinking.delta events for a given messageId, separated by intervening
    // message.delta events (interleaved thinking).
    type ThinkingRound = {
      content: string;
      firstIdx: number;
      lastIdx: number;
    };
    const thinkingRoundsByMessageId = new Map<string, ThinkingRound[]>();

    // Build message.delta indices per messageId for efficient intervening-delta detection
    const messageDeltaIdxByMessageId = new Map<string, number[]>();
    for (const event of orderedEventsByIdx) {
      if (event.type !== "message.delta" || event.payload.role !== "assistant") continue;
      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
      if (messageId.length === 0) continue;
      const existing = messageDeltaIdxByMessageId.get(messageId) ?? [];
      existing.push(event.idx);
      messageDeltaIdxByMessageId.set(messageId, existing);
    }

    for (const event of orderedEventsByIdx) {
      if (event.type !== "thinking.delta") continue;
      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
      const delta = typeof event.payload.delta === "string" ? event.payload.delta : "";
      if (messageId.length === 0 || delta.length === 0) continue;

      const rounds = thinkingRoundsByMessageId.get(messageId) ?? [];
      const currentRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;

      let startNewRound = currentRound === null;
      if (currentRound && !startNewRound) {
        // Check if any message.delta idx falls between the last thinking idx and this one
        const deltaIdxes = messageDeltaIdxByMessageId.get(messageId) ?? [];
        startNewRound = deltaIdxes.some(
          (idx) => idx > currentRound.lastIdx && idx < event.idx,
        );
      }

      if (startNewRound) {
        rounds.push({ content: delta, firstIdx: event.idx, lastIdx: event.idx });
      } else {
        currentRound!.content += delta;
        currentRound!.lastIdx = event.idx;
      }

      thinkingRoundsByMessageId.set(messageId, rounds);
    }

    const planFileOutputByMessageId = new Map<string, {
      id: string;
      messageId: string;
      content: string;
      filePath: string;
      idx: number;
      createdAt: string;
    }>();
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

      const content = typeof event.payload.content === "string" ? event.payload.content : "";
      const filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "plan.md";
      if (content.trim().length === 0) {
        continue;
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

    const sortedMessages = [...messages].sort((a, b) => a.seq - b.seq);
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
    const nextAssistantStartIdxByMessageId = new Map<string, number>();
    for (let index = 0; index < assistantMessages.length; index += 1) {
      const currentMessage = assistantMessages[index];
      for (let nextIndex = index + 1; nextIndex < assistantMessages.length; nextIndex += 1) {
        const nextStartIdx = firstMessageEventIdxById.get(assistantMessages[nextIndex].id);
        if (typeof nextStartIdx === "number") {
          nextAssistantStartIdxByMessageId.set(currentMessage.id, nextStartIdx);
          break;
        }
      }
    }

    let previousAssistantBoundaryIdx = -1;
    for (const message of assistantMessages) {
      const completedIdx = completedEventIdxByMessageId.get(message.id);
      const nextAssistantStartIdx = nextAssistantStartIdxByMessageId.get(message.id);
      const upperBoundaryIdx =
        typeof completedIdx === "number"
          ? completedIdx
          : typeof nextAssistantStartIdx === "number"
            ? nextAssistantStartIdx - 1
            : Number.POSITIVE_INFINITY;
      const context = inlineToolEvents.filter((event) => {
        if (event.idx <= previousAssistantBoundaryIdx) {
          return false;
        }
        return event.idx <= upperBoundaryIdx;
      });

      assistantContextById.set(message.id, context);
      pushRenderDebug({
        source: "WorkspacePage",
        event: "activityContextCollected",
        messageId: message.id,
        details: {
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

    type SortableEntry = {
      item: ChatTimelineItem;
      anchorIdx: number;
      timestamp: number | null;
      rank: number;
      stableOrder: number;
    };
    const sortable: SortableEntry[] = [];
    const assignedToolEventIds = new Set<string>();

    for (const message of sortedMessages) {
      const anchorIdx = firstMessageEventIdxById.get(message.id) ?? MAX_ORDER_INDEX;
      const firstAssistantDeltaTimestamp = message.role === "assistant"
        ? parseTimestamp(assistantDeltaEventsByMessageId.get(message.id)?.[0]?.createdAt ?? "")
        : null;
      const timestamp = firstAssistantDeltaTimestamp ?? parseTimestamp(message.createdAt);
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

      if (
        message.role === "assistant" &&
        !hasToolEventsInContext &&
        (shouldSkipMessageBecausePlanCard || (message.content.trim().length === 0 && !isCompleted && !hasMessageDelta))
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

      // Extract sub-agent groups FIRST so their child events are excluded from bash/explore grouping
      const subagentGroups = message.role === "assistant" ? extractSubagentGroups(context) : [];
      const subagentEventIds = new Set<string>();
      for (const group of subagentGroups) {
        group.eventIds.forEach((id) => subagentEventIds.add(id));
      }
      // Parse ###subagent summary start/end markers from message.content to extract
      // the subagent's response when the event-based lastMessage population fails.
      // Also strip markers from message.content for clean rendering.
      // Match both "###subagent summary start" and "###subagent summary" (without "start")
      // since the AI may emit either variant.
      const subagentSummaryRegex = /###subagent summary(?:\s+start)?\n?([\s\S]*?)###subagent summary end\n?/g;
      // Match both "###main summary start/end" and "###main agent summary/end"
      const mainSummaryStartMarker = /###main(?:\s+agent)? summary(?:\s+start)?\n?/g;
      const mainSummaryEndMarker = /###main(?:\s+agent)? summary end\n?/g;

      let cleanedContent = message.content;

      if (subagentGroups.length > 0 && message.content.length > 0) {
        // Extract subagent summary from message.content for groups missing lastMessage
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

        // Strip the subagent summary block and main summary markers from message content
        // so they aren't rendered as raw ### headers in the chat text.
        // Reset regex lastIndex since we used .exec() above which moves it.
        subagentSummaryRegex.lastIndex = 0;
        cleanedContent = message.content
          .replace(subagentSummaryRegex, "")
          .replace(mainSummaryStartMarker, "")
          .replace(mainSummaryEndMarker, "")
          .trim();
      }

      // Always strip the subagent summary block and main summary markers from
      // message content so they aren't rendered as raw ### headers in the chat
      // text.  This needs to run even when subagentGroups is empty (e.g. during
      // streaming before subagent events arrive).
      if (message.role === "assistant" && message.content.length > 0) {
        subagentSummaryRegex.lastIndex = 0;
        mainSummaryStartMarker.lastIndex = 0;
        mainSummaryEndMarker.lastIndex = 0;
        cleanedContent = message.content
          .replace(subagentSummaryRegex, "")
          .replace(mainSummaryEndMarker, "")
          .replace(mainSummaryStartMarker, "")
          .trim();
      }
      const nonSubagentContext = message.role === "assistant"
        ? context.filter((event) => !subagentEventIds.has(event.id))
        : context;

      const allBashRuns = message.role === "assistant" ? extractBashRuns(nonSubagentContext) : [];
      // Separate explore-like bash commands (ls, find, tree, etc.) from regular bash runs
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
          // Keep explore-like bash events in the non-bash context so they flow into explore grouping
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
      const exploreContext = nonBashContext.filter((event) => !isWorktreeDiffEvent(event));
      const deltaEventsForExplore = message.role === "assistant"
        ? (assistantDeltaEventsByMessageId.get(message.id) ?? [])
        : [];
      const exploreContextWithDeltas = deltaEventsForExplore.length > 0
        ? [...exploreContext, ...deltaEventsForExplore].sort((a, b) => a.idx - b.idx)
        : exploreContext;
      const exploreActivityGroups = message.role === "assistant" ? extractExploreActivityGroups(exploreContextWithDeltas) : [];
      const exploreEventIds = new Set<string>();
      for (const group of exploreActivityGroups) {
        group.eventIds.forEach((id) => exploreEventIds.add(id));
      }
      const activityContext = message.role === "assistant"
        ? nonBashContext.filter((event) => !isWorktreeDiffEvent(event) && !exploreEventIds.has(event.id))
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
        for (const group of exploreActivityGroups) {
          group.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
        for (const group of subagentGroups) {
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

      // Always claim activityContext events even when inline inserts exist
      // (bash/edit/explore/subagent). Without this, uncategorized tools like
      // TodoWrite leak as orphan "tool" timeline items showing raw status badges.
      if (message.role === "assistant" && activityContext.length > 0 && bashRuns.length > 0) {
        activityContext.forEach((event) => assignedToolEventIds.add(event.id));
      }

      // Insert thinking blocks for all assistant messages (including those with inline inserts).
      // Each "round" is a contiguous run of thinking.delta events separated by message.delta events.
      // Skip thinking blocks for messages that produced a plan file output — the plan card replaces them.
      if (message.role === "assistant" && !planFileOutput) {
        const rounds = thinkingRoundsByMessageId.get(message.id) ?? [];
        for (let i = 0; i < rounds.length; i++) {
          const round = rounds[i];
          if (round.content.length === 0) continue;
          sortable.push({
            item: {
              kind: "thinking",
              id: `thinking:${message.id}:${i}`,
              messageId: message.id,
              content: round.content,
              isStreaming: i === rounds.length - 1 && !isCompleted
                && refs.streamingMessageIds.has(message.id)
                && (assistantDeltaEventsByMessageId.get(message.id)?.length ?? 0) === 0,
            },
            anchorIdx: round.firstIdx > 0 ? round.firstIdx - 0.5 : 0,
            timestamp,
            rank: 2,
            stableOrder: message.seq - 0.001 + (i * 0.0001),
          });
        }
      }

      if (message.role === "assistant" && (bashRuns.length > 0 || editedRuns.length > 0 || exploreActivityGroups.length > 0 || subagentGroups.length > 0 || !!planFileOutput)) {
        const hasInlineExploreRuns = exploreActivityGroups.length > 0;
        const hasInlineSubagentRuns = subagentGroups.length > 0;
        type InlineInsert =
          | {
            kind: "bash";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            run: BashRun;
          }
          | {
            kind: "edited";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            run: EditedRun;
          }
          | {
            kind: "explore-activity";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            group: ExploreActivityGroup;
          }
          | {
            kind: "subagent-activity";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            group: SubagentGroup;
          }
          | {
            kind: "plan-file-output";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            planFileOutput: { id: string; messageId: string; content: string; filePath: string; idx: number; createdAt: string };
          };

        const inlineInserts: InlineInsert[] = [
          ...bashRuns.map((run, index) => ({
            kind: "bash" as const,
            id: `bash:${run.toolUseId}:${index}`,
            startIdx: run.startIdx,
            anchorIdx: run.anchorIdx,
            createdAt: run.createdAt,
            run,
          })),
          ...editedRuns
            .filter((run) => !(run.id.startsWith("edited:worktree:") && bashRuns.length > 0 && run.additions === 0))
            .map((run, index) => ({
              kind: "edited" as const,
              id: `edited:${run.eventId}:${index}`,
              startIdx: run.startIdx,
              anchorIdx: run.anchorIdx,
              createdAt: run.createdAt,
              run,
            })),
          ...(hasInlineExploreRuns ? exploreActivityGroups.map((group, index) => ({
            kind: "explore-activity" as const,
            id: `explore:${group.id}:${index}`,
            startIdx: group.startIdx,
            anchorIdx: group.anchorIdx,
            createdAt: group.createdAt,
            group,
          })) : []),
          ...(hasInlineSubagentRuns ? subagentGroups.map((group, index) => ({
            kind: "subagent-activity" as const,
            id: `subagent:${group.id}:${index}`,
            startIdx: group.startIdx,
            anchorIdx: group.anchorIdx,
            createdAt: group.createdAt,
            group,
          })) : []),
          ...(planFileOutput ? [{
            kind: "plan-file-output" as const,
            id: `plan:${planFileOutput.id}`,
            startIdx: planFileOutput.idx,
            anchorIdx: planFileOutput.idx,
            createdAt: planFileOutput.createdAt,
            planFileOutput,
          }] : []),
        ].sort((a, b) => {
          if (a.startIdx !== b.startIdx) {
            return a.startIdx - b.startIdx;
          }

          if (a.anchorIdx !== b.anchorIdx) {
            return a.anchorIdx - b.anchorIdx;
          }

          return a.id.localeCompare(b.id);
        });

        const messageDeltaEvents = assistantDeltaEventsByMessageId.get(message.id) ?? [];
        const segmentBuckets = Array.from({ length: inlineInserts.length + 1 }, () => ({
          content: "",
          anchorIdx: null as number | null,
          timestamp: null as number | null,
        }));

        // Filter out post-plan delta events — post-plan text (e.g. "Ready whenever
        // you approve!") is redundant since the plan card implies approval is needed.
        const planInlineInsertIdx = inlineInserts.findIndex(i => i.kind === "plan-file-output");
        let effectiveDeltaEvents = messageDeltaEvents;
        if (planInlineInsertIdx >= 0) {
          const planStartIdx = inlineInserts[planInlineInsertIdx].startIdx;
          effectiveDeltaEvents = messageDeltaEvents.filter(e => e.idx < planStartIdx);
          // Also strip post-plan text from cleanedContent so fallback paths
          // don't re-introduce it.
          const postPlanText = messageDeltaEvents
            .filter(e => e.idx >= planStartIdx)
            .map(e => typeof e.payload.delta === "string" ? e.payload.delta : "")
            .join("");
          if (postPlanText.length > 0 && cleanedContent.endsWith(postPlanText)) {
            cleanedContent = cleanedContent.slice(0, -postPlanText.length).trimEnd();
          }
        }

        for (const deltaEvent of effectiveDeltaEvents) {
          const deltaText = typeof deltaEvent.payload.delta === "string" ? deltaEvent.payload.delta : "";
          if (deltaText.length === 0) {
            continue;
          }

          let bucketIndex = inlineInserts.findIndex((insert) => deltaEvent.idx < insert.startIdx);
          if (bucketIndex < 0) {
            bucketIndex = inlineInserts.length;
          }

          const bucket = segmentBuckets[bucketIndex];
          bucket.content += deltaText;
          bucket.anchorIdx = bucket.anchorIdx == null ? deltaEvent.idx : Math.min(bucket.anchorIdx, deltaEvent.idx);
          if (bucket.timestamp == null) {
            bucket.timestamp = parseTimestamp(deltaEvent.createdAt);
          }
        }

        const totalSegmentLength = segmentBuckets.reduce((sum, b) => sum + b.content.length, 0);
        const hasSegmentContent = totalSegmentLength > 0;
        const deltasCoverageRatio = cleanedContent.length > 0 ? totalSegmentLength / cleanedContent.length : 1;
        const deltasSignificantlyIncomplete = hasSegmentContent && deltasCoverageRatio < 0.9;

        // Suppress text segments when subagent groups with valid lastMessage exist
        // AND the cleaned content is empty (i.e., the entire message was just
        // subagent summary + main summary markers, nothing else to show).
        // When cleanedContent still has text (the main agent's own commentary),
        // we need to replace the raw segments with the cleaned version.
        const allSubagentsHaveResponse = hasInlineSubagentRuns
          && subagentGroups.every((g) => (g.lastMessage?.length ?? 0) > 0);
        const suppressTextSegments = allSubagentsHaveResponse && cleanedContent.trim().length === 0;

        if (suppressTextSegments) {
          // Clear all text segments — nothing to show after stripping subagent content
          for (const bucket of segmentBuckets) {
            bucket.content = "";
            bucket.anchorIdx = null;
            bucket.timestamp = null;
          }
        } else if (allSubagentsHaveResponse && cleanedContent.length > 0) {
          if (hasSegmentContent && !deltasSignificantlyIncomplete) {
            // Deltas have good coverage — strip subagent/main summary markers from
            // each bucket individually to preserve text positioning around subagent cards.
            // This keeps intro text BEFORE the card and follow-up text AFTER it.
            for (const bucket of segmentBuckets) {
              if (bucket.content.length > 0) {
                bucket.content = bucket.content
                  .replace(subagentSummaryRegex, "")
                  .replace(mainSummaryStartMarker, "")
                  .replace(mainSummaryEndMarker, "")
                  .trim();
              }
            }
          } else {
            // Deltas are insufficient — fall back to putting cleanedContent after last insert.
            for (const bucket of segmentBuckets) {
              bucket.content = "";
              bucket.anchorIdx = null;
              bucket.timestamp = null;
            }
            segmentBuckets[0] = {
              content: cleanedContent,
              anchorIdx: inlineInserts.length > 0
                ? inlineInserts[inlineInserts.length - 1].startIdx + 1
                : anchorIdx,
              timestamp,
            };
          }
        } else if ((!hasSegmentContent || deltasSignificantlyIncomplete) && cleanedContent.length > 0) {
          for (const bucket of segmentBuckets) {
            bucket.content = "";
            bucket.anchorIdx = null;
            bucket.timestamp = null;
          }
          // When deltas are incomplete, place the full message content in bucket 0.
          // For subagent scenarios the text is the agent's response AFTER the subagent
          // completed, so anchor it after the last insert. Otherwise keep it before the
          // first insert (existing behaviour for bash/edit/explore).
          const fallbackBucketIndex = 0;
          const fallbackAnchorIdx = inlineInserts.length > 0
            ? hasInlineSubagentRuns
              ? inlineInserts[inlineInserts.length - 1].startIdx + 1
              : inlineInserts[0].startIdx - 1
            : anchorIdx;
          segmentBuckets[fallbackBucketIndex] = {
            content: cleanedContent,
            anchorIdx: fallbackAnchorIdx,
            timestamp,
          };
        }



        const MIN_STANDALONE_SEGMENT_LENGTH = 20;
        for (let mergeIdx = 1; mergeIdx < segmentBuckets.length; mergeIdx++) {
          const mBucket = segmentBuckets[mergeIdx];
          if (mBucket.content.length === 0 || mBucket.content.trim().length >= MIN_STANDALONE_SEGMENT_LENGTH) {
            continue;
          }
          let merged = false;
          // Try merging forward first
          for (let nextIdx = mergeIdx + 1; nextIdx < segmentBuckets.length; nextIdx++) {
            if (segmentBuckets[nextIdx].content.length > 0) {
              segmentBuckets[nextIdx].content = mBucket.content + segmentBuckets[nextIdx].content;
              const nextAnchor = segmentBuckets[nextIdx].anchorIdx;
              if (mBucket.anchorIdx != null && (nextAnchor == null || mBucket.anchorIdx < nextAnchor)) {
                segmentBuckets[nextIdx].anchorIdx = mBucket.anchorIdx;
              }
              if (segmentBuckets[nextIdx].timestamp == null) {
                segmentBuckets[nextIdx].timestamp = mBucket.timestamp;
              }
              mBucket.content = "";
              mBucket.anchorIdx = null;
              mBucket.timestamp = null;
              merged = true;
              break;
            }
          }
          // If forward merge failed, merge backward
          if (!merged) {
            for (let prevIdx = mergeIdx - 1; prevIdx >= 0; prevIdx--) {
              if (segmentBuckets[prevIdx].content.length > 0) {
                segmentBuckets[prevIdx].content += mBucket.content;
                mBucket.content = "";
                mBucket.anchorIdx = null;
                mBucket.timestamp = null;
                break;
              }
            }
          }
        }

        for (let fixIdx = 1; fixIdx < segmentBuckets.length; fixIdx++) {
          const curContent = segmentBuckets[fixIdx].content;
          if (curContent.length === 0) continue;
          const firstNonWs = curContent.trimStart().charAt(0);
          if (![",", ".", ";", "?", "!", ")", "]", "}"].includes(firstNonWs)) continue;
          for (let prevIdx = fixIdx - 1; prevIdx >= 0; prevIdx--) {
            const prevContent = segmentBuckets[prevIdx].content;
            if (prevContent.length === 0) continue;
            const trailingMatch = prevContent.match(/(\w+)\s*$/);
            if (!trailingMatch) break;
            const word = trailingMatch[1];
            const cutPos = prevContent.length - trailingMatch[0].length;
            segmentBuckets[prevIdx].content = prevContent.slice(0, cutPos);
            segmentBuckets[fixIdx].content = word + curContent;
            break;
          }
        }

        const hasLeadingText = segmentBuckets[0].content.length > 0;
        const hasAnyTrailingText = segmentBuckets.slice(1).some((bucket) => bucket.content.length > 0);
        const firstInsertKind = inlineInserts[0]?.kind ?? null;
        const deferFirstInsertUntilText =
          !hasLeadingText
          && hasAnyTrailingText
          && inlineInserts.length > 0
          && !isSentenceAwareInlineInsertKind(firstInsertKind);
        const delayFirstInlineInsert = shouldDelayFirstInlineInsert(
          firstInsertKind,
          segmentBuckets[0]?.content ?? "",
          hasAnyTrailingText,
        );
        let shouldDelayFirstInsert = deferFirstInsertUntilText || delayFirstInlineInsert;
        let nextInsertIndex = 0;
        let stableOffset = 0;
        let delayedFirstSegmentContent = "";
        let delayedFirstSegmentAnchorIdx: number | null = null;
        let delayedFirstSegmentTimestamp: number | null = null;

        function pushInlineInsert(insert: InlineInsert, bucketTimestamp?: number | null, bucketAnchorIdx?: number | null) {
          if (insert.kind === "plan-file-output") {
            // Plan card is pushed separately — this inline insert only acts as a text split point
            stableOffset += 0.001;
            return;
          }

          if (insert.kind === "bash") {
            const run = insert.run;
            const status = run.status === "running" && isCompleted ? "success" : run.status;
            sortable.push({
              item: {
                kind: "bash-command",
                id: `${message.id}:${run.toolUseId}:${insert.id}`,
                toolUseId: run.toolUseId,
                shell: "bash",
                command: run.command,
                summary: run.summary,
                output: run.output,
                error: run.error,
                truncated: run.truncated,
                durationSeconds: run.durationSeconds,
                status,
                rejectedByUser: run.rejectedByUser,
              },
              anchorIdx: bucketAnchorIdx ?? run.anchorIdx,
              timestamp: parseTimestamp(run.createdAt) ?? timestamp,
              rank: 3,
              stableOrder: message.seq + stableOffset,
            });
            stableOffset += 0.001;
            return;
          }

          if (insert.kind === "edited") {
            const run = insert.run;
            sortable.push({
              item: {
                kind: "edited-diff",
                id: `${message.id}:${run.eventId}:${insert.id}`,
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
              anchorIdx: bucketAnchorIdx ?? run.anchorIdx,
              timestamp: bucketTimestamp ?? timestamp,
              rank: 3,
              stableOrder: message.seq + stableOffset,
            });
            stableOffset += 0.001;
            return;
          }

          if (insert.kind === "subagent-activity") {
            const group = insert.group;
            const resolvedStatus = group.status === "running" && isCompleted ? "success" : group.status;
            const resolvedSteps = isCompleted
              ? group.steps.map((s) => s.status === "running" ? { ...s, status: "success" as const } : s)
              : group.steps;
            sortable.push({
              item: {
                kind: "subagent-activity",
                id: `${message.id}:${group.id}:${insert.id}`,
                agentId: group.agentId,
                agentType: group.agentType,
                toolUseId: group.toolUseId,
                status: resolvedStatus,
                description: group.description,
                lastMessage: group.lastMessage,
                steps: resolvedSteps,
                durationSeconds: group.durationSeconds,
              },
              anchorIdx: bucketAnchorIdx ?? group.anchorIdx,
              timestamp: bucketTimestamp ?? timestamp,
              rank: 3,
              stableOrder: message.seq + stableOffset,
            });
            stableOffset += 0.001;
            return;
          }

          const group = insert.group;
          const resolvedExploreStatus = group.status === "running" && isCompleted ? "success" : group.status;
          const resolvedEntries = isCompleted
            ? group.entries.map((e) => e.pending ? { ...e, pending: false } : e)
            : group.entries;
          sortable.push({
            item: {
              kind: "explore-activity",
              id: `${message.id}:${group.id}:${insert.id}`,
              status: resolvedExploreStatus,
              fileCount: group.fileCount,
              searchCount: group.searchCount,
              entries: resolvedEntries,
            },
            anchorIdx: bucketAnchorIdx ?? group.anchorIdx,
            timestamp: bucketTimestamp ?? timestamp,
            rank: 3,
            stableOrder: message.seq + stableOffset,
          });
          stableOffset += 0.001;
        }

        function pushMessageSegment(content: string, segmentIdSuffix: string, segmentAnchorIdx: number | null, segmentTimestamp: number | null) {
          if (content.length === 0) {
            return;
          }

          const segmentMessage: ChatMessage = {
            ...message,
            id: `${message.id}:segment:${segmentIdSuffix}`,
            content,
          };
          sortable.push({
            item: {
              kind: "message",
              message: segmentMessage,
              renderHint: renderHint === "diff" ? "diff" : "markdown",
              rawFileLanguage: undefined,
              isCompleted,
              context: nonBashContext,
            },
            anchorIdx: segmentAnchorIdx ?? anchorIdx,
            timestamp: segmentTimestamp ?? timestamp,
            rank: 3,
            stableOrder: message.seq + stableOffset,
          });
          stableOffset += 0.001;
        }

        for (let bucketIndex = 0; bucketIndex < segmentBuckets.length; bucketIndex += 1) {
          const bucket = segmentBuckets[bucketIndex];
          if (bucket.content.length > 0) {
            if (
              shouldDelayFirstInsert
              && nextInsertIndex === 0
              && isSentenceAwareInlineInsertKind(firstInsertKind)
            ) {
              delayedFirstSegmentContent += bucket.content;
              delayedFirstSegmentAnchorIdx = delayedFirstSegmentAnchorIdx == null
                ? bucket.anchorIdx
                : bucket.anchorIdx == null
                  ? delayedFirstSegmentAnchorIdx
                  : Math.min(delayedFirstSegmentAnchorIdx, bucket.anchorIdx);
              if (delayedFirstSegmentTimestamp == null) {
                delayedFirstSegmentTimestamp = bucket.timestamp;
              }

              const splitSegment = splitAtFirstSentenceBoundary(delayedFirstSegmentContent);
              const isLastBucket = bucketIndex === segmentBuckets.length - 1;
              if (!splitSegment && !isLastBucket) {
                continue;
              }

              if (splitSegment) {
                const tailIsAnnouncement = (bucket.anchorIdx ?? 0) < inlineInserts[0].startIdx;
                pushMessageSegment(
                  splitSegment.head,
                  `${bucketIndex}:delayed-head`,
                  inlineInserts[0].startIdx - 0.5,
                  delayedFirstSegmentTimestamp,
                );
                if (tailIsAnnouncement && splitSegment.tail.length > 0) {
                  pushMessageSegment(
                    splitSegment.tail,
                    `${bucketIndex}:delayed-tail`,
                    inlineInserts[0].startIdx,
                    bucket.timestamp ?? delayedFirstSegmentTimestamp,
                  );
                }
                pushInlineInsert(inlineInserts[0], bucket.timestamp);
                if (!tailIsAnnouncement && splitSegment.tail.length > 0) {
                  pushMessageSegment(
                    splitSegment.tail,
                    `${bucketIndex}:delayed-tail`,
                    inlineInserts[0].startIdx,
                    bucket.timestamp ?? delayedFirstSegmentTimestamp,
                  );
                }
                nextInsertIndex = 1;
                shouldDelayFirstInsert = false;
              } else {
                pushMessageSegment(
                  delayedFirstSegmentContent,
                  `${bucketIndex}:delayed-fallback`,
                  delayedFirstSegmentAnchorIdx,
                  delayedFirstSegmentTimestamp,
                );
                pushInlineInsert(inlineInserts[0], bucket.timestamp);
                nextInsertIndex = 1;
                shouldDelayFirstInsert = false;
              }

              delayedFirstSegmentContent = "";
              delayedFirstSegmentAnchorIdx = null;
              delayedFirstSegmentTimestamp = null;

              while (nextInsertIndex <= bucketIndex && nextInsertIndex < inlineInserts.length) {
                pushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
                nextInsertIndex += 1;
              }
              continue;
            }

            let segmentRendered = false;
            if (
              nextInsertIndex === 0
              && isSentenceAwareInlineInsertKind(firstInsertKind)
              && hasAnyTrailingText
              && inlineInserts.length > 0
            ) {
              const splitSegment = hasSentenceBoundary(bucket.content) ? splitAtFirstSentenceBoundary(bucket.content) : null;
              if (splitSegment) {
                const tailIsAnnouncement = (bucket.anchorIdx ?? 0) < inlineInserts[0].startIdx;
                pushMessageSegment(splitSegment.head, `${bucketIndex}:head`, bucket.anchorIdx, bucket.timestamp);
                if (tailIsAnnouncement && splitSegment.tail.length > 0) {
                  pushMessageSegment(splitSegment.tail, `${bucketIndex}:tail`, inlineInserts[0].startIdx, bucket.timestamp);
                }
                pushInlineInsert(inlineInserts[0], bucket.timestamp);
                if (!tailIsAnnouncement && splitSegment.tail.length > 0) {
                  pushMessageSegment(splitSegment.tail, `${bucketIndex}:tail`, inlineInserts[0].startIdx, bucket.timestamp);
                }
                nextInsertIndex = 1;
                shouldDelayFirstInsert = false;
                segmentRendered = true;
              }
            }

            if (!segmentRendered) {
              pushMessageSegment(bucket.content, `${bucketIndex}`, bucket.anchorIdx, bucket.timestamp);
            }

            if (shouldDelayFirstInsert && nextInsertIndex === 0 && bucketIndex > 0) {
              pushInlineInsert(inlineInserts[0], bucket.timestamp, bucket.anchorIdx);
              nextInsertIndex = 1;
              shouldDelayFirstInsert = false;
            }
          }

          while (nextInsertIndex <= bucketIndex && nextInsertIndex < inlineInserts.length) {
            const shouldHoldLeadingSentenceAwareInsert =
              nextInsertIndex === 0
              && isSentenceAwareInlineInsertKind(firstInsertKind)
              && hasAnyTrailingText
              && bucketIndex === 0;
            if (shouldHoldLeadingSentenceAwareInsert) {
              break;
            }
            if (shouldDelayFirstInsert && nextInsertIndex === 0) {
              break;
            }
            pushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
            nextInsertIndex += 1;
          }
        }

        while (nextInsertIndex < inlineInserts.length) {
          pushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
          nextInsertIndex += 1;
        }

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

    // --- Orphan subagent grouping ---
    // Before rendering orphans, check if any unassigned events form subagent groups.
    // This handles the case where subagent events arrive before any assistant message.delta.
    const chatTerminated = orderedEventsByIdx.some(
      (event) => event.type === "chat.completed" || event.type === "chat.failed",
    );
    const unassignedInlineForSubagent = inlineToolEvents.filter(
      (event) => !assignedToolEventIds.has(event.id),
    );
    const orphanSubagentGroups = extractSubagentGroups(unassignedInlineForSubagent);
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

    // --- Orphan explore-activity grouping ---
    // Before rendering orphans as flat tool badges, check if any unassigned events
    // form explore-activity groups (Read, Glob, Grep, explore-like Bash).
    // This handles the case where explore events become orphans because the
    // assistant message was skipped or boundary edge cases.
    const unassignedForExplore = inlineToolEvents.filter(
      (event) => !assignedToolEventIds.has(event.id),
    );
    const orphanExploreGroups = extractExploreActivityGroups(unassignedForExplore);
    for (const group of orphanExploreGroups) {
      group.eventIds.forEach((id) => assignedToolEventIds.add(id));
      const resolvedStatus = group.status === "running" && chatTerminated ? "success" : group.status;
      const resolvedEntries = chatTerminated
        ? group.entries.map((e) => e.pending ? { ...e, pending: false } : e)
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

    const orphanToolEvents = inlineToolEvents
      .filter((event) => !assignedToolEventIds.has(event.id))
      .filter((event) =>
        event.type !== "permission.requested"
        && event.type !== "permission.resolved"
        && event.type !== "subagent.started"
        && event.type !== "subagent.finished"
      )
      .sort((a, b) => a.idx - b.idx);
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
    for (const event of orphanToolEvents) {
      if (isWorktreeDiffEvent(event)) {
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
          event,
        },
        anchorIdx: event.idx,
        timestamp: parseTimestamp(event.createdAt),
        rank: 0,
        stableOrder: event.idx,
      });
    }

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

    return sortable.map((entry) => entry.item);
  }, [messages, events, selectedThreadId]);
}
