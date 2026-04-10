import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import {
  buildTimelineFromSeed as buildTimelineFromCore,
  type TimelineAssemblyResult,
} from "@codesymphony/chat-timeline-core";

export function buildTimelineFromSeed(params: {
  messages: ChatMessage[];
  events: ChatEvent[];
  selectedThreadId: string | null;
  semanticHydrationInProgress?: boolean;
}): TimelineAssemblyResult {
  return buildTimelineFromCore(params);
}
