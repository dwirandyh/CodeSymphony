import type { ChatEvent, ChatThreadStatus } from "@codesymphony/shared-types";

type PendingPlan = {
  createdIdx: number;
  status: "pending" | "sending" | "approved";
};

function payloadStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetadataToolEvent(event: ChatEvent): boolean {
  return event.payload.source === "chat.thread.metadata";
}

function isPlanFilePath(filePath: string): boolean {
  if (!filePath.endsWith(".md")) {
    return false;
  }

  return (
    filePath.includes(".claude/plans/")
    || filePath.includes(".cursor/plans/")
    || filePath.includes("codesymphony-claude-provider/plans/")
  );
}

function isClaudePlanFilePayload(payload: Record<string, unknown>): boolean {
  const rawSource = payload.source;
  if (rawSource === "claude_plan_file" || rawSource === "codex_plan_item") {
    return true;
  }

  const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
  return isPlanFilePath(filePath);
}

function normalizePlanCreatedEvent(event: ChatEvent, orderedEvents: ChatEvent[]): { idx: number } | null {
  if (event.type !== "plan.created") {
    return null;
  }

  const rawSource = event.payload.source;
  if (rawSource !== "streaming_fallback" && !isClaudePlanFilePayload(event.payload)) {
    return null;
  }

  let content = payloadStringOrNull(event.payload.content) ?? "";
  let filePath = payloadStringOrNull(event.payload.filePath) ?? "plan.md";
  if (content.trim().length === 0) {
    return null;
  }

  if (event.payload.source === "streaming_fallback" && !isPlanFilePath(filePath)) {
    const realWrite = orderedEvents.find((candidate) =>
      candidate.idx > event.idx
      && candidate.type === "tool.finished"
      && isPlanFilePath(
        payloadStringOrNull(candidate.payload.editTarget)
          ?? payloadStringOrNull(candidate.payload.file_path)
          ?? "",
      )
    );
    if (!realWrite) {
      return null;
    }

    const toolInput = isRecord(realWrite.payload.toolInput) ? realWrite.payload.toolInput : null;
    const realContent = toolInput ? payloadStringOrNull(toolInput.content) : null;
    const realPath = payloadStringOrNull(realWrite.payload.editTarget)
      ?? payloadStringOrNull(realWrite.payload.file_path)
      ?? filePath;
    if (!realContent || realContent.trim().length === 0) {
      return null;
    }

    content = realContent;
    filePath = realPath;
    if (!isPlanFilePath(filePath)) {
      return null;
    }

    return { idx: realWrite.idx };
  }

  return { idx: event.idx };
}

function toOrderedEvents(events: ChatEvent[]): ChatEvent[] {
  return [...events].sort((left, right) => left.idx - right.idx);
}

function hasPendingPermissionRequests(events: ChatEvent[]): boolean {
  const pending = new Set<string>();

  for (const event of toOrderedEvents(events)) {
    if (event.type === "permission.requested") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      if (requestId) {
        pending.add(requestId);
      }
      continue;
    }

    if (event.type === "permission.resolved") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      if (requestId) {
        pending.delete(requestId);
      }
      continue;
    }

    if (event.type === "chat.completed" || event.type === "chat.failed") {
      pending.clear();
    }
  }

  return pending.size > 0;
}

function hasPendingQuestionRequests(events: ChatEvent[]): boolean {
  const pending = new Set<string>();

  for (const event of toOrderedEvents(events)) {
    if (event.type === "question.requested") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      if (requestId) {
        pending.add(requestId);
      }
      continue;
    }

    if (event.type === "question.answered" || event.type === "question.dismissed") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      if (requestId) {
        pending.delete(requestId);
      }
      continue;
    }

    if (event.type === "chat.completed" || event.type === "chat.failed") {
      pending.clear();
    }
  }

  return pending.size > 0;
}

function derivePendingPlan(events: ChatEvent[]): PendingPlan | null {
  const orderedEvents = toOrderedEvents(events);
  let latestPlan: PendingPlan | null = null;

  for (const event of orderedEvents) {
    if (event.type === "plan.created") {
      const normalized = normalizePlanCreatedEvent(event, orderedEvents);
      if (!normalized) {
        continue;
      }

      latestPlan = {
        createdIdx: normalized.idx,
        status: "pending",
      };
      continue;
    }

    if (event.type === "plan.approved") {
      if (latestPlan) {
        latestPlan = { ...latestPlan, status: "approved" };
      }
      continue;
    }

    if (event.type === "plan.dismissed") {
      latestPlan = null;
      continue;
    }

    if (event.type === "plan.revision_requested" && latestPlan) {
      latestPlan = { ...latestPlan, status: "sending" };
    }
  }

  return latestPlan;
}

function getFinishedToolNames(event: ChatEvent, toolNameByUseId: Map<string, string>): string[] {
  if (event.type !== "tool.finished") {
    return [];
  }

  const directToolName = typeof event.payload.toolName === "string"
    ? event.payload.toolName.trim().toLowerCase()
    : "";
  if (directToolName.length > 0) {
    return [directToolName];
  }

  const precedingToolUseIds = Array.isArray(event.payload.precedingToolUseIds)
    ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

  return precedingToolUseIds
    .map((toolUseId) => toolNameByUseId.get(toolUseId) ?? "")
    .filter((toolName) => toolName.length > 0);
}

function isPlanReviewReady(events: ChatEvent[], pendingPlan: PendingPlan | null): boolean {
  if (!pendingPlan || pendingPlan.status !== "pending") {
    return false;
  }

  const orderedEvents = toOrderedEvents(events);
  const toolNameByUseId = new Map<string, string>();
  let fallbackCompletionIdx: number | null = null;

  for (const event of orderedEvents) {
    if (event.idx <= pendingPlan.createdIdx) {
      if (event.type === "tool.started") {
        const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
        const toolName = payloadStringOrNull(event.payload.toolName)?.trim().toLowerCase() ?? "";
        if (toolUseId.length > 0 && toolName.length > 0) {
          toolNameByUseId.set(toolUseId, toolName);
        }
      }
      continue;
    }

    if (event.type === "tool.started") {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      const toolName = payloadStringOrNull(event.payload.toolName)?.trim().toLowerCase() ?? "";
      if (toolUseId.length > 0 && toolName.length > 0) {
        toolNameByUseId.set(toolUseId, toolName);
      }
      continue;
    }

    if (event.type === "tool.finished") {
      if (getFinishedToolNames(event, toolNameByUseId).some((toolName) => toolName === "exitplanmode")) {
        return true;
      }
      continue;
    }

    if ((event.type === "chat.completed" || event.type === "chat.failed") && fallbackCompletionIdx == null) {
      fallbackCompletionIdx = event.idx;
    }
  }

  return fallbackCompletionIdx != null;
}

function hasRunningAssistantActivity(events: ChatEvent[]): boolean {
  const orderedEvents = toOrderedEvents(events);
  const activeToolUseIds = new Set<string>();
  const activeSubagentToolUseIds = new Set<string>();
  let sawAssistantActivitySinceTerminalEvent = false;

  for (const event of orderedEvents) {
    if (event.type === "chat.completed" || event.type === "chat.failed") {
      activeToolUseIds.clear();
      activeSubagentToolUseIds.clear();
      sawAssistantActivitySinceTerminalEvent = false;
      continue;
    }

    if (event.type === "tool.started") {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      if (toolUseId.length > 0) {
        activeToolUseIds.add(toolUseId);
      }
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "tool.finished") {
      if (isMetadataToolEvent(event)) {
        continue;
      }

      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      if (toolUseId.length > 0) {
        activeToolUseIds.delete(toolUseId);
      }

      const precedingToolUseIds = Array.isArray(event.payload.precedingToolUseIds)
        ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : [];
      for (const precedingToolUseId of precedingToolUseIds) {
        activeToolUseIds.delete(precedingToolUseId);
      }

      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "subagent.started") {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      if (toolUseId.length > 0) {
        activeSubagentToolUseIds.add(toolUseId);
      }
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "subagent.finished") {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      if (toolUseId.length > 0) {
        activeSubagentToolUseIds.delete(toolUseId);
      }
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (event.type === "message.delta" && event.payload.role === "assistant") {
      sawAssistantActivitySinceTerminalEvent = true;
      continue;
    }

    if (
      event.type === "tool.output"
      || event.type === "permission.requested"
      || event.type === "question.requested"
      || event.type === "plan.created"
    ) {
      sawAssistantActivitySinceTerminalEvent = true;
    }
  }

  return (
    activeToolUseIds.size > 0
    || activeSubagentToolUseIds.size > 0
    || sawAssistantActivitySinceTerminalEvent
  );
}

export function deriveThreadStatusFromEvents(events: ChatEvent[], isActive: boolean): ChatThreadStatus {
  if (hasPendingPermissionRequests(events) || hasPendingQuestionRequests(events)) {
    return "waiting_approval";
  }

  const pendingPlan = derivePendingPlan(events);
  if (pendingPlan?.status === "pending" && isPlanReviewReady(events, pendingPlan)) {
    return "review_plan";
  }

  if (isActive || hasRunningAssistantActivity(events)) {
    return "running";
  }

  return "idle";
}
