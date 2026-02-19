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
  isClaudePlanFilePayload,
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

      if (
        message.role === "assistant" &&
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
      const nonSubagentContext = message.role === "assistant"
        ? context.filter((event) => !subagentEventIds.has(event.id))
        : context;

      const bashRuns = message.role === "assistant" ? extractBashRuns(nonSubagentContext) : [];
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
      const editedRuns = message.role === "assistant" ? extractEditedRuns(nonBashContext, context) : [];
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

      if (message.role === "assistant" && (bashRuns.length > 0 || editedRuns.length > 0 || exploreActivityGroups.length > 0 || subagentGroups.length > 0)) {
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

        for (const deltaEvent of messageDeltaEvents) {
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
        const deltasCoverageRatio = message.content.length > 0 ? totalSegmentLength / message.content.length : 1;
        const deltasSignificantlyIncomplete = hasSegmentContent && deltasCoverageRatio < 0.9;
        if ((!hasSegmentContent || deltasSignificantlyIncomplete) && message.content.length > 0) {
          for (const bucket of segmentBuckets) {
            bucket.content = "";
            bucket.anchorIdx = null;
            bucket.timestamp = null;
          }
          // When deltas are incomplete, place the full message content in bucket 0
          // (before any inline inserts) so the text renders above subagent/explore/bash
          // activities. Use an anchorIdx just before the first insert to maintain sort order.
          const fallbackBucketIndex = 0;
          const fallbackAnchorIdx = inlineInserts.length > 0
            ? inlineInserts[0].startIdx - 1
            : anchorIdx;
          segmentBuckets[fallbackBucketIndex] = {
            content: message.content,
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
            sortable.push({
              item: {
                kind: "subagent-activity",
                id: `${message.id}:${group.id}:${insert.id}`,
                agentId: group.agentId,
                agentType: group.agentType,
                toolUseId: group.toolUseId,
                status: group.status,
                description: group.description,
                lastMessage: group.lastMessage,
                steps: group.steps,
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
          sortable.push({
            item: {
              kind: "explore-activity",
              id: `${message.id}:${group.id}:${insert.id}`,
              status: group.status,
              fileCount: group.fileCount,
              searchCount: group.searchCount,
              entries: group.entries,
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
                  delayedFirstSegmentAnchorIdx,
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
