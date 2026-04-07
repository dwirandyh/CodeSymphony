import { SENTENCE_BOUNDARY_PATTERN, SENTENCE_BOUNDARY_SCAN_LIMIT } from "./constants.js";

const THINK_BLOCK_PATTERN = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_TAG_PATTERN = /<\/?think\b[^>]*>/gi;

export function splitAtFirstSentenceBoundary(text: string): { head: string; tail: string } | null {
  if (text.length === 0) {
    return null;
  }

  const scanTarget = text.slice(0, SENTENCE_BOUNDARY_SCAN_LIMIT);
  const match = SENTENCE_BOUNDARY_PATTERN.exec(scanTarget);
  if (!match) {
    return null;
  }

  const boundaryIdx = match.index + match[0].length;
  if (boundaryIdx <= 0) {
    return null;
  }

  return {
    head: text.slice(0, boundaryIdx),
    tail: text.slice(boundaryIdx),
  };
}

export function sanitizeAssistantVisibleText(text: string): string {
  if (text.length === 0) {
    return text;
  }

  return text
    .replace(THINK_BLOCK_PATTERN, " ")
    .replace(THINK_TAG_PATTERN, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

export function stripAssistantControlMarkup(text: string): string {
  if (text.length === 0) {
    return text;
  }

  return text
    .replace(THINK_BLOCK_PATTERN, "")
    .replace(THINK_TAG_PATTERN, "");
}

const COLON_BOUNDARY_PATTERN = /:\s*(?=[A-Z])/;

export function splitAtContentBoundary(text: string): { head: string; tail: string } | null {
  if (text.length === 0) return null;

  const scanTarget = text.slice(0, SENTENCE_BOUNDARY_SCAN_LIMIT);
  const colonMatch = COLON_BOUNDARY_PATTERN.exec(scanTarget);
  const sentenceMatch = SENTENCE_BOUNDARY_PATTERN.exec(scanTarget);

  const colonIdx = colonMatch && colonMatch.index > 0
    ? colonMatch.index + colonMatch[0].length
    : null;
  const sentenceIdx = sentenceMatch
    ? sentenceMatch.index + sentenceMatch[0].length
    : null;

  if (colonIdx != null && sentenceIdx != null) {
    const idx = Math.min(colonIdx, sentenceIdx);
    return { head: text.slice(0, idx), tail: text.slice(idx) };
  }

  if (colonIdx != null) {
    return { head: text.slice(0, colonIdx), tail: text.slice(colonIdx) };
  }

  if (sentenceIdx != null) {
    return { head: text.slice(0, sentenceIdx), tail: text.slice(sentenceIdx) };
  }

  return null;
}

export function hasSentenceBoundary(text: string): boolean {
  return splitAtFirstSentenceBoundary(text) != null;
}

export function isSentenceAwareInlineInsertKind(kind: string | null): boolean {
  return kind === "edited" || kind === "bash" || kind === "subagent-activity" || kind === "explore-activity";
}

export function shouldDelayFirstInlineInsert(
  firstInsertKind: string | null,
  leadingContent: string,
  hasAnyTrailingText: boolean,
): boolean {
  if (!isSentenceAwareInlineInsertKind(firstInsertKind) || !hasAnyTrailingText) {
    return false;
  }

  if (leadingContent.length === 0) {
    return false;
  }

  return !hasSentenceBoundary(leadingContent);
}
