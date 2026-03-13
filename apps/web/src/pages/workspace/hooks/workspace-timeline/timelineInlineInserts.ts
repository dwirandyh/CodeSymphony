import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { AssistantRenderHint } from "../../../../components/workspace/chat-message-list";
import { SENTENCE_BOUNDARY_PATTERN } from "../../constants";
import {
  hasSentenceBoundary,
  isSentenceAwareInlineInsertKind,
  shouldDelayFirstInlineInsert,
  splitAtFirstSentenceBoundary,
} from "../../textUtils";
import { parseTimestamp } from "../../eventUtils";
import { debugLog } from "../../../../lib/debugLog";
import type { InlineInsert, PlanFileOutput, SegmentBucket, SortableEntry, TimelineRefs } from "./useWorkspaceTimeline.types";
import type { BashRun, EditedRun, ExploreActivityGroup, SubagentGroup } from "../../types";

export function buildInlineInserts(
  bashRuns: BashRun[],
  editedRuns: EditedRun[],
  exploreActivityGroups: ExploreActivityGroup[],
  subagentGroups: SubagentGroup[],
  planFileOutput: PlanFileOutput | undefined,
): InlineInsert[] {
  const hasInlineExploreRuns = exploreActivityGroups.length > 0;
  const hasInlineSubagentRuns = subagentGroups.length > 0;

  return [
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
    ...(hasInlineExploreRuns ? exploreActivityGroups.map((group) => ({
      kind: "explore-activity" as const,
      id: group.id,
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
}

export function buildSegmentBuckets(
  inlineInserts: InlineInsert[],
  effectiveDeltaEvents: ChatEvent[],
): SegmentBucket[] {
  const segmentBuckets: SegmentBucket[] = Array.from({ length: inlineInserts.length + 1 }, () => ({
    content: "",
    anchorIdx: null,
    timestamp: null,
  }));

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

  const ANNOUNCE_IDX_GAP = 5;
  for (let mergeBackIdx = 1; mergeBackIdx < segmentBuckets.length && mergeBackIdx <= inlineInserts.length; mergeBackIdx++) {
    const prevInsert = inlineInserts[mergeBackIdx - 1];
    const bkt = segmentBuckets[mergeBackIdx];
    if (!prevInsert || bkt.content.length === 0) continue;
    if (bkt.anchorIdx != null && bkt.anchorIdx <= prevInsert.startIdx + ANNOUNCE_IDX_GAP) {
      const prevBucket = segmentBuckets[mergeBackIdx - 1];
      prevBucket.content += bkt.content;
      if (prevBucket.anchorIdx == null) {
        prevBucket.anchorIdx = bkt.anchorIdx;
      }
      if (prevBucket.timestamp == null) {
        prevBucket.timestamp = bkt.timestamp;
      }
      bkt.content = "";
      bkt.anchorIdx = null;
      bkt.timestamp = null;
    }
  }

  for (let bi = 0; bi < segmentBuckets.length - 1; bi++) {
    const bkt = segmentBuckets[bi];
    if (bkt.content.length === 0) continue;
    const sbp = new RegExp(SENTENCE_BOUNDARY_PATTERN.source, "g");
    let lastEnd = -1;
    let m: RegExpExecArray | null;
    while ((m = sbp.exec(bkt.content)) !== null) {
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd > 0 && lastEnd < bkt.content.length) {
      const trailing = bkt.content.slice(lastEnd);
      segmentBuckets[bi + 1].content = trailing + segmentBuckets[bi + 1].content;
      if (segmentBuckets[bi + 1].anchorIdx == null) {
        segmentBuckets[bi + 1].anchorIdx = bkt.anchorIdx;
      }
      if (segmentBuckets[bi + 1].timestamp == null) {
        segmentBuckets[bi + 1].timestamp = bkt.timestamp;
      }
      bkt.content = bkt.content.slice(0, lastEnd);
    }
  }

  for (let ri = 0; ri < segmentBuckets.length - 1; ri++) {
    const bkt = segmentBuckets[ri];
    if (bkt.content.length === 0) continue;
    const trimmed = bkt.content.trimEnd();
    if (trimmed.length === 0) continue;
    const lastChar = trimmed.slice(-1);
    if (".!?\"')".includes(lastChar)) continue;

    const nextBkt = segmentBuckets[ri + 1];
    if (nextBkt.content.length === 0) continue;
    const firstChar = nextBkt.content.trimStart().charAt(0);
    if (firstChar && (firstChar === firstChar.toLowerCase() || /\d/.test(firstChar))) {
      bkt.content += nextBkt.content;
      nextBkt.content = "";
      nextBkt.anchorIdx = null;
      nextBkt.timestamp = null;
    }
  }

  return segmentBuckets;
}

export function applySubagentContentCleaning(
  segmentBuckets: SegmentBucket[],
  cleanedContent: string,
  hasInlineSubagentRuns: boolean,
  subagentGroups: SubagentGroup[],
  subagentSummaryRegex: RegExp,
  mainSummaryRegex: RegExp,
  mainSummaryStartMarker: RegExp,
  mainSummaryEndMarker: RegExp,
  totalSegmentLength: number,
  deltasSignificantlyIncomplete: boolean,
  inlineInserts: InlineInsert[],
  anchorIdx: number,
  timestamp: number | null,
): void {
  const hasSegmentContent = totalSegmentLength > 0;
  const allSubagentsHaveResponse = hasInlineSubagentRuns
    && subagentGroups.every((g) => (g.lastMessage?.length ?? 0) > 0);
  const suppressTextSegments = allSubagentsHaveResponse && cleanedContent.trim().length === 0;

  if (suppressTextSegments) {
    for (const bucket of segmentBuckets) {
      bucket.content = "";
      bucket.anchorIdx = null;
      bucket.timestamp = null;
    }
  } else if (allSubagentsHaveResponse && cleanedContent.length > 0) {
    if (hasSegmentContent && !deltasSignificantlyIncomplete) {
      for (const bucket of segmentBuckets) {
        if (bucket.content.length > 0) {
          bucket.content = bucket.content
            .replace(subagentSummaryRegex, "")
            .replace(mainSummaryRegex, "")
            .replace(mainSummaryStartMarker, "")
            .replace(mainSummaryEndMarker, "")
            .trim();
        }
      }
    } else {
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
    const fallbackBucketIndex = 0;
    const fallbackAnchorIdx = inlineInserts.length > 0
      ? hasInlineSubagentRuns
        ? inlineInserts[inlineInserts.length - 1].startIdx + 1
        : inlineInserts[0].startIdx + 1
      : anchorIdx;
    segmentBuckets[fallbackBucketIndex] = {
      content: cleanedContent,
      anchorIdx: fallbackAnchorIdx,
      timestamp,
    };
  }
}

export function mergeSmallSegments(segmentBuckets: SegmentBucket[]): void {
  const MIN_STANDALONE_SEGMENT_LENGTH = 20;
  for (let mergeIdx = 1; mergeIdx < segmentBuckets.length; mergeIdx++) {
    const mBucket = segmentBuckets[mergeIdx];
    if (mBucket.content.length === 0 || mBucket.content.trim().length >= MIN_STANDALONE_SEGMENT_LENGTH) {
      continue;
    }
    let merged = false;
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
}

export function fixPunctuationSplits(segmentBuckets: SegmentBucket[]): void {
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
}

export function pushInlineInsert(
  insert: InlineInsert,
  sortable: SortableEntry[],
  message: ChatMessage,
  isCompleted: boolean,
  timestamp: number | null,
  stableOffset: { value: number },
  bucketTimestamp?: number | null,
  bucketAnchorIdx?: number | null,
): void {
  if (insert.kind === "plan-file-output") {
    stableOffset.value += 0.001;
    return;
  }

  if (insert.kind === "bash") {
    const run = insert.run;
    const status = run.status === "running" && isCompleted ? "success" : run.status;
    sortable.push({
      item: {
        kind: "tool",
        id: `${message.id}:${run.toolUseId}:${insert.id}`,
        event: null,
        sourceEvents: [],
        toolUseId: run.toolUseId,
        toolName: "Bash",
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
      stableOrder: message.seq + stableOffset.value,
    });
    stableOffset.value += 0.001;
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
      stableOrder: message.seq + stableOffset.value,
    });
    stableOffset.value += 0.001;
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
      stableOrder: message.seq + stableOffset.value,
    });
    stableOffset.value += 0.001;
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
      id: group.id,
      status: resolvedExploreStatus,
      fileCount: group.fileCount,
      searchCount: group.searchCount,
      entries: resolvedEntries,
    },
    anchorIdx: bucketAnchorIdx ?? group.anchorIdx,
    timestamp: bucketTimestamp ?? timestamp,
    rank: 3,
    stableOrder: message.seq + stableOffset.value,
  });
  stableOffset.value += 0.001;
}

export function pushMessageSegment(
  content: string,
  segmentIdSuffix: string,
  segmentAnchorIdx: number | null,
  segmentTimestamp: number | null,
  sortable: SortableEntry[],
  message: ChatMessage,
  renderHint: AssistantRenderHint | undefined,
  isCompleted: boolean,
  nonBashContext: ChatEvent[],
  anchorIdx: number,
  timestamp: number | null,
  stableOffset: { value: number },
): void {
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
    stableOrder: message.seq + stableOffset.value,
  });
  stableOffset.value += 0.001;
}

export function processInlineInsertLoop(
  segmentBuckets: SegmentBucket[],
  inlineInserts: InlineInsert[],
  sortable: SortableEntry[],
  message: ChatMessage,
  renderHint: AssistantRenderHint | undefined,
  isCompleted: boolean,
  nonBashContext: ChatEvent[],
  anchorIdx: number,
  timestamp: number | null,
  stableOffset: { value: number },
  refs: TimelineRefs,
  selectedThreadId: string | null,
): void {
  const firstInlineInsert = inlineInserts[0] ?? null;
  const firstInsertLogKey = `${selectedThreadId ?? "no-thread"}:${message.id}`;
  let firstInsertOrderingLogged = false;

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

  let delayedFirstSegmentContent = "";
  let delayedFirstSegmentAnchorIdx: number | null = null;
  let delayedFirstSegmentTimestamp: number | null = null;

  const logFirstInsertOrdering = (
    decision: "tool-before-text" | "text-before-tool" | "delay-first-insert",
    options?: {
      bucketIndex?: number;
      bucketAnchorIdx?: number | null;
      splitHeadLength?: number;
      splitTailLength?: number;
    },
  ) => {
    if (!firstInlineInsert || firstInsertOrderingLogged) {
      return;
    }
    if (refs.loggedFirstInsertOrderByMessageId.has(firstInsertLogKey)) {
      firstInsertOrderingLogged = true;
      return;
    }

    refs.loggedFirstInsertOrderByMessageId.add(firstInsertLogKey);
    firstInsertOrderingLogged = true;

    const firstNonEmptyBucketIndex = segmentBuckets.findIndex((bucket) => bucket.content.length > 0);
    const firstNonEmptyBucket = firstNonEmptyBucketIndex >= 0
      ? segmentBuckets[firstNonEmptyBucketIndex]
      : null;

    debugLog("useWorkspaceTimeline", "first-insert-ordering", {
      threadId: selectedThreadId,
      messageId: message.id,
      decision,
      firstInsertKind: firstInlineInsert.kind,
      firstInsertId: firstInlineInsert.id,
      firstInsertStartIdx: firstInlineInsert.startIdx,
      firstInsertAnchorIdx: firstInlineInsert.anchorIdx,
      firstNonEmptyBucketIndex,
      firstNonEmptyBucketAnchorIdx: firstNonEmptyBucket?.anchorIdx ?? null,
      firstNonEmptyBucketLength: firstNonEmptyBucket?.content.length ?? 0,
      firstBucketAnchorIdx: segmentBuckets[0]?.anchorIdx ?? null,
      hasAnyTrailingText,
      firstInsertHasTrailingTextScenario: hasAnyTrailingText && segmentBuckets[0].content.length === 0,
      bucketIndex: options?.bucketIndex ?? null,
      bucketAnchorIdx: options?.bucketAnchorIdx ?? null,
      splitHeadLength: options?.splitHeadLength ?? null,
      splitTailLength: options?.splitTailLength ?? null,
    });
  };

  const doPushInlineInsert = (insert: InlineInsert, bTimestamp?: number | null, bAnchorIdx?: number | null) => {
    pushInlineInsert(insert, sortable, message, isCompleted, timestamp, stableOffset, bTimestamp, bAnchorIdx);
  };

  const doPushMessageSegment = (content: string, segmentIdSuffix: string, segmentAnchorIdx: number | null, segmentTimestamp: number | null) => {
    pushMessageSegment(content, segmentIdSuffix, segmentAnchorIdx, segmentTimestamp, sortable, message, renderHint, isCompleted, nonBashContext, anchorIdx, timestamp, stableOffset);
  };

  for (let bucketIndex = 0; bucketIndex < segmentBuckets.length; bucketIndex += 1) {
    const bucket = segmentBuckets[bucketIndex];
    if (bucket.content.length > 0) {
      if (
        bucketIndex > 0
        && delayedFirstSegmentContent.length > 0
        && nextInsertIndex === 0
        && shouldDelayFirstInsert
      ) {
        doPushMessageSegment(
          delayedFirstSegmentContent,
          "0:delayed-flush",
          delayedFirstSegmentAnchorIdx,
          delayedFirstSegmentTimestamp,
        );
        doPushInlineInsert(inlineInserts[0], delayedFirstSegmentTimestamp);
        nextInsertIndex = 1;
        shouldDelayFirstInsert = false;
        delayedFirstSegmentContent = "";
        delayedFirstSegmentAnchorIdx = null;
        delayedFirstSegmentTimestamp = null;

        while (nextInsertIndex < bucketIndex && nextInsertIndex < inlineInserts.length) {
          doPushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
          nextInsertIndex += 1;
        }
      }

      if (
        shouldDelayFirstInsert
        && nextInsertIndex === 0
        && isSentenceAwareInlineInsertKind(firstInsertKind)
      ) {
        logFirstInsertOrdering("delay-first-insert", {
          bucketIndex,
          bucketAnchorIdx: bucket.anchorIdx,
        });
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
        if (!splitSegment && !isLastBucket && bucketIndex === 0) {
          continue;
        }

        if (splitSegment) {
          const tailIsAnnouncement = (bucket.anchorIdx ?? 0) < inlineInserts[0].startIdx;
          doPushMessageSegment(
            splitSegment.head,
            `${bucketIndex}:delayed-head`,
            inlineInserts[0].startIdx - 0.5,
            delayedFirstSegmentTimestamp,
          );
          if (tailIsAnnouncement && splitSegment.tail.length > 0) {
            doPushMessageSegment(
              splitSegment.tail,
              `${bucketIndex}:delayed-tail`,
              inlineInserts[0].startIdx,
              bucket.timestamp ?? delayedFirstSegmentTimestamp,
            );
          }
          doPushInlineInsert(inlineInserts[0], bucket.timestamp);
          if (!tailIsAnnouncement && splitSegment.tail.length > 0) {
            doPushMessageSegment(
              splitSegment.tail,
              `${bucketIndex}:delayed-tail`,
              inlineInserts[0].startIdx,
              bucket.timestamp ?? delayedFirstSegmentTimestamp,
            );
          }
          nextInsertIndex = 1;
          shouldDelayFirstInsert = false;
        } else {
          doPushMessageSegment(
            delayedFirstSegmentContent,
            `${bucketIndex}:delayed-fallback`,
            delayedFirstSegmentAnchorIdx,
            delayedFirstSegmentTimestamp,
          );
          doPushInlineInsert(inlineInserts[0], bucket.timestamp);
          nextInsertIndex = 1;
          shouldDelayFirstInsert = false;
        }

        delayedFirstSegmentContent = "";
        delayedFirstSegmentAnchorIdx = null;
        delayedFirstSegmentTimestamp = null;

        while (nextInsertIndex <= bucketIndex && nextInsertIndex < inlineInserts.length) {
          doPushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
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
        const textIsAfterInsert = (bucket.anchorIdx ?? 0) > inlineInserts[0].startIdx;
        if (textIsAfterInsert) {
          logFirstInsertOrdering("tool-before-text", {
            bucketIndex,
            bucketAnchorIdx: bucket.anchorIdx,
          });
          doPushInlineInsert(inlineInserts[0], bucket.timestamp);
          doPushMessageSegment(bucket.content, `${bucketIndex}`, bucket.anchorIdx, bucket.timestamp);
          nextInsertIndex = 1;
          shouldDelayFirstInsert = false;
          segmentRendered = true;
        } else {
          const splitSegment = hasSentenceBoundary(bucket.content) ? splitAtFirstSentenceBoundary(bucket.content) : null;
          if (splitSegment) {
            logFirstInsertOrdering("text-before-tool", {
              bucketIndex,
              bucketAnchorIdx: bucket.anchorIdx,
              splitHeadLength: splitSegment.head.length,
              splitTailLength: splitSegment.tail.length,
            });
            doPushMessageSegment(splitSegment.head, `${bucketIndex}:head`, bucket.anchorIdx, bucket.timestamp);
            doPushInlineInsert(inlineInserts[0], bucket.timestamp);
            if (splitSegment.tail.length > 0) {
              doPushMessageSegment(splitSegment.tail, `${bucketIndex}:tail`, inlineInserts[0].startIdx, bucket.timestamp);
            }
            nextInsertIndex = 1;
            shouldDelayFirstInsert = false;
            segmentRendered = true;
          }
        }
      }

      if (!segmentRendered) {
        doPushMessageSegment(bucket.content, `${bucketIndex}`, bucket.anchorIdx, bucket.timestamp);
      }

      if (shouldDelayFirstInsert && nextInsertIndex === 0 && bucketIndex > 0) {
        doPushInlineInsert(inlineInserts[0], bucket.timestamp, bucket.anchorIdx);
        nextInsertIndex = 1;
        shouldDelayFirstInsert = false;
      }
    }

    while (nextInsertIndex <= bucketIndex && nextInsertIndex < inlineInserts.length) {
      const shouldHoldLeadingSentenceAwareInsert =
        nextInsertIndex === 0
        && isSentenceAwareInlineInsertKind(firstInsertKind)
        && firstInsertKind !== "subagent-activity"
        && hasAnyTrailingText
        && bucketIndex === 0;
      if (shouldHoldLeadingSentenceAwareInsert) {
        break;
      }
      if (shouldDelayFirstInsert && nextInsertIndex === 0) {
        break;
      }
      doPushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
      nextInsertIndex += 1;
    }
  }

  while (nextInsertIndex < inlineInserts.length) {
    doPushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
    nextInsertIndex += 1;
  }
}

export function filterPostPlanDeltaEvents(
  messageDeltaEvents: ChatEvent[],
  inlineInserts: InlineInsert[],
  cleanedContent: string,
): { effectiveDeltaEvents: ChatEvent[]; cleanedContent: string } {
  const planInlineInsertIdx = inlineInserts.findIndex(i => i.kind === "plan-file-output");
  let effectiveDeltaEvents = messageDeltaEvents;
  let result = cleanedContent;
  if (planInlineInsertIdx >= 0) {
    const planStartIdx = inlineInserts[planInlineInsertIdx].startIdx;
    const postPlanText = messageDeltaEvents
      .filter(e => e.idx >= planStartIdx)
      .map(e => typeof e.payload.delta === "string" ? e.payload.delta : "")
      .join("");
    if (postPlanText.length > 0) {
      effectiveDeltaEvents = messageDeltaEvents.filter(e => e.idx < planStartIdx);
      if (result.endsWith(postPlanText)) {
        result = result.slice(0, -postPlanText.length).trimEnd();
      } else if (result.endsWith(postPlanText.trimEnd())) {
        result = result.slice(0, -postPlanText.trimEnd().length).trimEnd();
      } else {
        const prePlanDeltaText = effectiveDeltaEvents
          .map(e => typeof e.payload.delta === "string" ? e.payload.delta : "")
          .join("");
        if (prePlanDeltaText.length > 0) {
          result = prePlanDeltaText;
        }
      }
    }
  }
  return { effectiveDeltaEvents, cleanedContent: result };
}
