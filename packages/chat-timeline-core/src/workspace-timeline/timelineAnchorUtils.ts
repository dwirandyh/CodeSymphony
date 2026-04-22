import type { ChatMessage } from "@codesymphony/shared-types";

export function computeMessageAnchorIdxById(
  sortedMessages: ChatMessage[],
  firstScopedEventIdxByMessageId: Map<string, number>,
  firstMessageEventIdxById: Map<string, number>,
  completedEventIdxByMessageId: Map<string, number>,
): Map<string, number> {
  const anchorByMessageId = new Map<string, number>();
  const knownAnchors: Array<{ index: number; anchorIdx: number }> = [];

  for (let index = 0; index < sortedMessages.length; index += 1) {
    const message = sortedMessages[index];
    const anchorIdx = firstScopedEventIdxByMessageId.get(message.id)
      ?? completedEventIdxByMessageId.get(message.id)
      ?? null;
    if (anchorIdx == null) {
      continue;
    }

    anchorByMessageId.set(message.id, anchorIdx);
    knownAnchors.push({ index, anchorIdx });
  }

  if (sortedMessages.length === 0) {
    return anchorByMessageId;
  }

  if (knownAnchors.length === 0) {
    for (const message of sortedMessages) {
      anchorByMessageId.set(message.id, message.seq);
    }
    return anchorByMessageId;
  }

  const positivePerMessageSteps: number[] = [];
  for (let knownIndex = 0; knownIndex < knownAnchors.length - 1; knownIndex += 1) {
    const left = knownAnchors[knownIndex];
    const right = knownAnchors[knownIndex + 1];
    const messageGap = right.index - left.index;
    const anchorGap = right.anchorIdx - left.anchorIdx;
    if (messageGap <= 0 || anchorGap <= 0) {
      continue;
    }
    positivePerMessageSteps.push(anchorGap / messageGap);
  }
  const inferredPerMessageStep = positivePerMessageSteps.length > 0
    ? [...positivePerMessageSteps].sort((a, b) => a - b)[Math.floor(positivePerMessageSteps.length / 2)]
    : 1;

  const firstKnownAnchor = knownAnchors[0];
  const firstKnownHasDelta = firstMessageEventIdxById.has(sortedMessages[firstKnownAnchor.index].id);
  for (let index = firstKnownAnchor.index - 1; index >= 0; index -= 1) {
    const message = sortedMessages[index];
    if (firstKnownHasDelta) {
      anchorByMessageId.set(message.id, message.seq);
      continue;
    }

    const distance = firstKnownAnchor.index - index;
    const projectedAnchor = firstKnownAnchor.anchorIdx - (distance * inferredPerMessageStep);
    anchorByMessageId.set(message.id, projectedAnchor);
  }

  for (let knownIndex = 0; knownIndex < knownAnchors.length - 1; knownIndex += 1) {
    const left = knownAnchors[knownIndex];
    const right = knownAnchors[knownIndex + 1];
    const gapCount = right.index - left.index - 1;
    if (gapCount <= 0) {
      continue;
    }

    const rawStep = (right.anchorIdx - left.anchorIdx) / (gapCount + 1);
    const step = rawStep > 0 ? rawStep : 0.0001;

    for (let offset = 1; offset <= gapCount; offset += 1) {
      const messageIndex = left.index + offset;
      anchorByMessageId.set(sortedMessages[messageIndex].id, left.anchorIdx + (step * offset));
    }
  }

  const lastKnownAnchor = knownAnchors[knownAnchors.length - 1];
  for (let index = lastKnownAnchor.index + 1; index < sortedMessages.length; index += 1) {
    const distance = index - lastKnownAnchor.index;
    const projectedAnchor = lastKnownAnchor.anchorIdx + (distance * inferredPerMessageStep);
    anchorByMessageId.set(sortedMessages[index].id, projectedAnchor);
  }

  return anchorByMessageId;
}
