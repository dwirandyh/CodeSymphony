import type {
  ChatEvent,
  ChatMessage,
  ChatTimelineItem,
  ChatTimelineSnapshot,
  ChatTimelineSummary,
} from "@codesymphony/shared-types";

const MAX_HASH_WINDOW = 512;
const messagesFingerprintCache = new WeakMap<ChatMessage[], string>();
const eventsFingerprintCache = new WeakMap<ChatEvent[], string>();
const timelineItemsFingerprintCache = new WeakMap<ChatTimelineItem[], string>();
const timelineSummaryFingerprintCache = new WeakMap<ChatTimelineSummary, string>();
const snapshotKeyCache = new WeakMap<object, string>();

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
    case "todo-list":
      return [
        "todo-list",
        item.id,
        item.messageId,
        item.agent,
        item.groupId,
        item.status,
        windowedSignature(item.explanation ?? ""),
        item.items.map((todo) => `${todo.id ?? ""}:${todo.status}:${windowedSignature(todo.content)}`).join("|"),
      ].join(":");
    case "todo-progress":
      return [
        "todo-progress",
        item.id,
        item.messageId,
        item.agent,
        item.groupId,
        item.todoId ?? "",
        windowedSignature(item.content),
      ].join(":");
    case "error":
      return `error:${item.id}:${windowedSignature(item.message)}`;
  }
}

export function buildMessagesStateFingerprint(messages: ChatMessage[]): string {
  const cached = messagesFingerprintCache.get(messages);
  if (cached) {
    return cached;
  }

  const fingerprint = messages.map((message) => buildMessageFingerprint(message)).join(";");
  messagesFingerprintCache.set(messages, fingerprint);
  return fingerprint;
}

export function buildEventsStateFingerprint(events: ChatEvent[]): string {
  const cached = eventsFingerprintCache.get(events);
  if (cached) {
    return cached;
  }

  const fingerprint = events.map((event) => buildEventFingerprint(event)).join(";");
  eventsFingerprintCache.set(events, fingerprint);
  return fingerprint;
}

function buildTimelineItemsStateFingerprint(items: ChatTimelineItem[]): string {
  const cached = timelineItemsFingerprintCache.get(items);
  if (cached) {
    return cached;
  }

  const fingerprint = items.map((item) => buildTimelineItemFingerprint(item)).join(";");
  timelineItemsFingerprintCache.set(items, fingerprint);
  return fingerprint;
}

function buildTimelineSummaryFingerprint(summary: ChatTimelineSummary): string {
  const cached = timelineSummaryFingerprintCache.get(summary);
  if (cached) {
    return cached;
  }

  const fingerprint = [
    summary.oldestRenderableKey ?? "",
    summary.oldestRenderableKind ?? "",
    summary.oldestRenderableMessageId ?? "",
    summary.oldestRenderableHydrationPending ? "1" : "0",
    summary.headIdentityStable ? "1" : "0",
  ].join(":");
  timelineSummaryFingerprintCache.set(summary, fingerprint);
  return fingerprint;
}

export function buildSnapshotKey(
  snapshot: Pick<
    ChatTimelineSnapshot,
    "newestSeq" | "newestIdx" | "messages" | "events" | "timelineItems" | "summary"
  >,
): string {
  const snapshotObject = snapshot as object;
  const cached = snapshotKeyCache.get(snapshotObject);
  if (cached) {
    return cached;
  }

  const snapshotKey = [
    snapshot.newestSeq ?? "null",
    snapshot.newestIdx ?? "null",
    hashString(buildMessagesStateFingerprint(snapshot.messages)),
    hashString(buildEventsStateFingerprint(snapshot.events)),
    hashString(buildTimelineItemsStateFingerprint(snapshot.timelineItems)),
    hashString(buildTimelineSummaryFingerprint(snapshot.summary)),
  ].join(":");
  snapshotKeyCache.set(snapshotObject, snapshotKey);
  return snapshotKey;
}
