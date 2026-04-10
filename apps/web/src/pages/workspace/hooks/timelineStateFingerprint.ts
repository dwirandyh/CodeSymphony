import type {
  ChatEvent,
  ChatMessage,
  ChatTimelineItem,
  ChatTimelineSnapshot,
  ChatTimelineSummary,
} from "@codesymphony/shared-types";

const MAX_HASH_WINDOW = 512;

function hashString(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function windowedSignature(value: string): string {
  if (value.length <= MAX_HASH_WINDOW * 2) {
    return `${value.length}:${hashString(value)}`;
  }

  const head = value.slice(0, MAX_HASH_WINDOW);
  const tail = value.slice(-MAX_HASH_WINDOW);
  return `${value.length}:${hashString(`${head}\u0000${tail}`)}`;
}

function stringifyPayload(payload: ChatEvent["payload"]): string {
  try {
    return JSON.stringify(payload ?? {});
  } catch {
    return "[unserializable-payload]";
  }
}

function buildMessageFingerprint(message: ChatMessage): string {
  const attachmentFingerprint = message.attachments
    .map((attachment) => [
      attachment.id,
      attachment.filename,
      attachment.mimeType,
      attachment.sizeBytes,
      attachment.source,
      attachment.storagePath,
      windowedSignature(attachment.content),
    ].join(":"))
    .join("|");

  return [
    message.id,
    message.seq,
    message.role,
    windowedSignature(message.content),
    attachmentFingerprint,
  ].join(":");
}

function buildEventFingerprint(event: ChatEvent): string {
  return [
    event.id,
    event.idx,
    event.type,
    windowedSignature(stringifyPayload(event.payload)),
  ].join(":");
}

function buildTimelineItemFingerprint(item: ChatTimelineItem): string {
  switch (item.kind) {
    case "message":
      return `message:${buildMessageFingerprint(item.message)}:${item.isCompleted ? "done" : "open"}`;
    case "tool":
      return [
        "tool",
        item.id,
        item.toolUseId ?? "",
        item.toolName ?? "",
        item.status ?? "",
        windowedSignature(item.summary ?? ""),
        windowedSignature(item.output ?? ""),
        windowedSignature(item.error ?? ""),
        item.sourceEvents?.map((event) => buildEventFingerprint(event)).join("|") ?? "",
      ].join(":");
    case "edited-diff":
      return [
        "edited-diff",
        item.id,
        item.changeSource ?? "edit-tool",
        item.status,
        item.diffKind,
        item.changedFiles.join("|"),
        item.additions,
        item.deletions,
        windowedSignature(item.diff),
      ].join(":");
    case "subagent-activity":
      return [
        "subagent-activity",
        item.id,
        item.agentId,
        item.status,
        windowedSignature(item.description),
        windowedSignature(item.lastMessage ?? ""),
        item.steps.map((step) => `${step.toolUseId}:${step.toolName}:${step.status}:${windowedSignature(step.label)}:${step.openPath ?? ""}`).join("|"),
      ].join(":");
    case "explore-activity":
      return [
        "explore-activity",
        item.id,
        item.status,
        item.fileCount,
        item.searchCount,
        item.entries.map((entry) => `${entry.kind}:${entry.pending ? "pending" : "done"}:${windowedSignature(entry.label)}:${entry.openPath ?? ""}`).join("|"),
      ].join(":");
    case "activity":
      return [
        "activity",
        item.messageId,
        windowedSignature(item.introText ?? ""),
        item.steps.map((step) => `${step.label}:${windowedSignature(step.detail ?? "")}`).join("|"),
      ].join(":");
    case "plan-file-output":
      return [
        "plan-file-output",
        item.id,
        item.messageId,
        item.filePath,
        windowedSignature(item.content),
      ].join(":");
    case "error":
      return `error:${item.id}:${windowedSignature(item.message)}`;
  }
}

export function buildMessagesStateFingerprint(messages: ChatMessage[]): string {
  return messages.map((message) => buildMessageFingerprint(message)).join(";");
}

export function buildEventsStateFingerprint(events: ChatEvent[]): string {
  return events.map((event) => buildEventFingerprint(event)).join(";");
}

function buildTimelineItemsStateFingerprint(items: ChatTimelineItem[]): string {
  return items.map((item) => buildTimelineItemFingerprint(item)).join(";");
}

function buildTimelineSummaryFingerprint(summary: ChatTimelineSummary): string {
  return [
    summary.oldestRenderableKey ?? "",
    summary.oldestRenderableKind ?? "",
    summary.oldestRenderableMessageId ?? "",
    summary.oldestRenderableHydrationPending ? "1" : "0",
    summary.headIdentityStable ? "1" : "0",
  ].join(":");
}

export function buildSnapshotKey(
  snapshot: Pick<
    ChatTimelineSnapshot,
    "newestSeq" | "newestIdx" | "messages" | "events" | "timelineItems" | "summary"
  >,
): string {
  return [
    snapshot.newestSeq ?? "null",
    snapshot.newestIdx ?? "null",
    hashString(buildMessagesStateFingerprint(snapshot.messages)),
    hashString(buildEventsStateFingerprint(snapshot.events)),
    hashString(buildTimelineItemsStateFingerprint(snapshot.timelineItems)),
    hashString(buildTimelineSummaryFingerprint(snapshot.summary)),
  ].join(":");
}
