import { useMemo, useRef } from "react";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { buildTimelineFromSeed, setTimelineDebugLogger } from "@codesymphony/chat-timeline-core";
import { pushRenderDebug } from "../../../../lib/renderDebug";
import {
  buildEventsStateFingerprint,
  buildMessagesStateFingerprint,
} from "../timelineStateFingerprint";
import type {
  TimelineRefs,
  WorkspaceTimelineResult,
  UseWorkspaceTimelineOptions,
} from "./useWorkspaceTimeline.types";

setTimelineDebugLogger((entry) => {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    pushRenderDebug(entry as Parameters<typeof pushRenderDebug>[0]);
  }
});

function getTimelineItemStableKey(item: { kind: string; [key: string]: unknown }): string {
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
    case "error":
      return `error:${item.id}`;
    default:
      return "unknown";
  }
}

export function useWorkspaceTimeline(
  messages: ChatMessage[],
  events: ChatEvent[],
  selectedThreadId: string | null,
  refs: TimelineRefs,
  options?: UseWorkspaceTimelineOptions,
): WorkspaceTimelineResult {
  const prevFingerprintRef = useRef<{
    messagesFingerprint: string;
    eventsFingerprint: string;
    threadId: string | null;
    semanticHydrationInProgress: boolean;
  } | null>(null);
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
      prevFingerprintRef.current = null;
      prevResultRef.current = disabledResult;
      return disabledResult;
    }

    const fingerprint = {
      messagesFingerprint: buildMessagesStateFingerprint(messages),
      eventsFingerprint: buildEventsStateFingerprint(events),
      threadId: selectedThreadId,
      semanticHydrationInProgress,
    };
    const prev = prevFingerprintRef.current;
    if (
      prev !== null
      && prev.messagesFingerprint === fingerprint.messagesFingerprint
      && prev.eventsFingerprint === fingerprint.eventsFingerprint
      && prev.threadId === fingerprint.threadId
      && prev.semanticHydrationInProgress === fingerprint.semanticHydrationInProgress
      && prevResultRef.current.items.length > 0
    ) {
      return prevResultRef.current;
    }

    const coreResult = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId,
      semanticHydrationInProgress,
    });

    refs.stickyRawFallbackMessageIds.clear();
    refs.renderDecisionByMessageId.clear();

    const previousSummary = prevResultRef.current.summary;
    const oldestRenderable = coreResult.items[0] ?? null;
    const oldestRenderableKey = coreResult.summary.oldestRenderableKey
      ?? (oldestRenderable ? getTimelineItemStableKey(oldestRenderable) : null);
    const oldestRenderableKind = coreResult.summary.oldestRenderableKind;
    const oldestRenderableMessageId = coreResult.summary.oldestRenderableMessageId;
    const oldestRenderableHydrationPending = coreResult.summary.oldestRenderableHydrationPending;
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
      items: coreResult.items,
      hasIncompleteCoverage: coreResult.hasIncompleteCoverage,
      summary: summaryUnchanged ? previousSummary : nextSummary,
    };

    pushRenderDebug({
      source: "useWorkspaceTimeline",
      event: "finalTimelineItems",
      messageId: selectedThreadId ?? undefined,
      details: {
        count: timelineResult.items.length,
      },
    });

    prevFingerprintRef.current = fingerprint;
    prevResultRef.current = timelineResult;
    return timelineResult;
  }, [messages, events, options?.disabled, options?.semanticHydrationInProgress, selectedThreadId, refs]);
}
