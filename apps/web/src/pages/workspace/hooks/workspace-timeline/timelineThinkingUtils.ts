import type { ChatEvent } from "@codesymphony/shared-types";
import { SENTENCE_BOUNDARY_PATTERN } from "../../constants";
import {
  hasSentenceBoundary,
  splitAtFirstSentenceBoundary,
} from "../../textUtils";
import type { ThinkingRound, PlanFileOutput, SortableEntry, InlineInsert } from "./useWorkspaceTimeline.types";
import type { BashRun, EditedRun, ExploreActivityGroup, SubagentGroup } from "../../types";

export function buildThinkingRounds(
  orderedEventsByIdx: ChatEvent[],
): Map<string, ThinkingRound[]> {
  const thinkingRoundsByMessageId = new Map<string, ThinkingRound[]>();

  for (const event of orderedEventsByIdx) {
    if (event.type !== "thinking.delta") continue;
    const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
    const delta = typeof event.payload.delta === "string" ? event.payload.delta : "";
    if (messageId.length === 0 || delta.length === 0) continue;

    const rounds = thinkingRoundsByMessageId.get(messageId) ?? [];
    const currentRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;

    let startNewRound = currentRound === null;
    if (currentRound && !startNewRound) {
      startNewRound = event.idx > currentRound.lastIdx + 1;
    }

    if (startNewRound) {
      rounds.push({ content: delta, firstIdx: event.idx, lastIdx: event.idx });
    } else {
      currentRound!.content += delta;
      currentRound!.lastIdx = event.idx;
    }

    thinkingRoundsByMessageId.set(messageId, rounds);
  }

  return thinkingRoundsByMessageId;
}

export function mergeThinkingRounds(
  rawRounds: ThinkingRound[],
  bashRuns: BashRun[],
  editedRuns: EditedRun[],
  exploreActivityGroups: ExploreActivityGroup[],
  subagentGroups: SubagentGroup[],
  planFileOutput: PlanFileOutput | undefined,
): ThinkingRound[] {
  const hasInlineInserts = bashRuns.length > 0 || editedRuns.length > 0 || exploreActivityGroups.length > 0 || subagentGroups.length > 0 || !!planFileOutput;

  let mergedRounds = rawRounds;
  if (hasInlineInserts && rawRounds.length > 1) {
    const insertStartIdxes = [
      ...bashRuns.map(r => r.startIdx),
      ...editedRuns.map(r => r.startIdx),
      ...exploreActivityGroups.map(g => g.startIdx),
      ...subagentGroups.map(g => g.startIdx),
      ...(planFileOutput ? [planFileOutput.idx] : []),
    ].sort((a, b) => a - b);

    const sectionOf = (idx: number) => {
      let section = 0;
      for (const boundary of insertStartIdxes) {
        if (idx >= boundary) section++;
        else break;
      }
      return section;
    };

    mergedRounds = [];
    for (const round of rawRounds) {
      const section = sectionOf(round.firstIdx);
      const prev = mergedRounds.length > 0 ? mergedRounds[mergedRounds.length - 1] : null;
      if (prev && sectionOf(prev.firstIdx) === section) {
        prev.content += round.content;
        prev.lastIdx = round.lastIdx;
      } else {
        mergedRounds.push({ ...round });
      }
    }

    const CROSS_BOUNDARY_FRAGMENT_CHAR_LIMIT = 180;
    const CROSS_BOUNDARY_FRAGMENT_WORD_LIMIT = 24;
    for (let mi = mergedRounds.length - 1; mi >= 1; mi--) {
      const cur = mergedRounds[mi];
      const firstNonWs = cur.content.trimStart();
      if (firstNonWs.length === 0) continue;
      const ch = firstNonWs.charAt(0);
      const isContinuation = ch === ch.toLowerCase() && ch !== ch.toUpperCase();
      if (!isContinuation) {
        continue;
      }

      const prev = mergedRounds[mi - 1];
      const hasInsertBetween = insertStartIdxes.some(
        b => b > prev.lastIdx && b <= cur.firstIdx,
      );
      if (hasInsertBetween) {
        if (!hasSentenceBoundary(cur.content)) {
          continue;
        }

        const split = splitAtFirstSentenceBoundary(cur.content);
        if (!split) {
          continue;
        }

        const leadingFragment = split.head.trim();
        if (split.tail.length === 0) {
          continue;
        }
        const leadingWords = leadingFragment.length > 0
          ? leadingFragment.split(/\s+/).length
          : 0;
        const isTightlyBoundedFragment =
          leadingFragment.length > 0
          && leadingFragment.length <= CROSS_BOUNDARY_FRAGMENT_CHAR_LIMIT
          && leadingWords <= CROSS_BOUNDARY_FRAGMENT_WORD_LIMIT;
        if (!isTightlyBoundedFragment) {
          continue;
        }

        prev.content += split.head;
        prev.lastIdx = Math.max(prev.lastIdx, cur.firstIdx);
        cur.content = split.tail;
        continue;
      }

      prev.content += cur.content;
      prev.lastIdx = cur.lastIdx;
      mergedRounds.splice(mi, 1);
    }
  }

  return mergedRounds;
}

export function insertThinkingItems(
  mergedRounds: ThinkingRound[],
  messageId: string,
  messageSeq: number,
  isCompleted: boolean,
  isStreamingMessage: boolean,
  hasMessageDelta: boolean,
  planFileOutput: PlanFileOutput | undefined,
  orderedEventsByIdx: ChatEvent[],
  timestamp: number | null,
  sortable: SortableEntry[],
): void {
  for (let i = 0; i < mergedRounds.length; i++) {
    const round = mergedRounds[i];
    if (round.content.length === 0) continue;
    if (planFileOutput && round.firstIdx > planFileOutput.idx) continue;
    let thinkingContent = round.content;

    if (planFileOutput && round.lastIdx > planFileOutput.idx && round.firstIdx < planFileOutput.idx) {
      let prePlanContent = "";
      for (const ev of orderedEventsByIdx) {
        if (ev.type !== "thinking.delta") continue;
        const mid = typeof ev.payload.messageId === "string" ? ev.payload.messageId : "";
        if (mid !== messageId) continue;
        if (ev.idx < round.firstIdx || ev.idx > round.lastIdx) continue;
        if (ev.idx >= planFileOutput.idx) break;
        prePlanContent += typeof ev.payload.delta === "string" ? ev.payload.delta : "";
      }
      if (prePlanContent.length > 0) {
        thinkingContent = prePlanContent;
      }
    }

    if (planFileOutput && thinkingContent.length > 0) {
      const PLAN_META_RE = /\b(plan\s+file|exit\s*plan\s*mode|ExitPlanMode|create\s+the\s+plan|write\s+the\s+plan|call\s+ExitPlanMode)\b/i;
      if (PLAN_META_RE.test(thinkingContent)) {
        const sentences = thinkingContent.split(/(?<=[.!?])\s+/);
        while (sentences.length > 0 && PLAN_META_RE.test(sentences[sentences.length - 1])) {
          sentences.pop();
        }
        thinkingContent = sentences.join(" ").trimEnd();
      }
    }

    if (thinkingContent.length === 0) continue;

    if (isCompleted && thinkingContent.length > 0) {
      const lastChar = thinkingContent.trimEnd().slice(-1);
      if (lastChar && !".!?\"')".includes(lastChar)) {
        const sbpTrim = new RegExp(SENTENCE_BOUNDARY_PATTERN.source, "g");
        let lastBoundaryEnd = -1;
        let mTrim: RegExpExecArray | null;
        while ((mTrim = sbpTrim.exec(thinkingContent)) !== null) {
          lastBoundaryEnd = mTrim.index + mTrim[0].length;
        }
        if (lastBoundaryEnd > 0) {
          thinkingContent = thinkingContent.slice(0, lastBoundaryEnd).trimEnd();
        }
      }
    }
    sortable.push({
      item: {
        kind: "thinking",
        id: `thinking:${messageId}:${i}`,
        messageId,
        content: thinkingContent,
        isStreaming: i === mergedRounds.length - 1 && !isCompleted
          && isStreamingMessage
          && !hasMessageDelta,
      },
      anchorIdx: round.firstIdx > 0 ? round.firstIdx - 0.5 : 0,
      timestamp,
      rank: 2,
      stableOrder: messageSeq - 0.001 + (i * 0.0001),
    });
  }
}
