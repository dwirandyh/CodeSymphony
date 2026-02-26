import { SENTENCE_BOUNDARY_PATTERN, SENTENCE_BOUNDARY_SCAN_LIMIT } from "./constants";

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

const COLON_BOUNDARY_PATTERN = /:\s*(?=[A-Z])/;

export function splitAtContentBoundary(text: string): { head: string; tail: string } | null {
  if (text.length === 0) return null;

  const scanTarget = text.slice(0, SENTENCE_BOUNDARY_SCAN_LIMIT);
  const colonMatch = COLON_BOUNDARY_PATTERN.exec(scanTarget);
  if (colonMatch && colonMatch.index > 0) {
    const idx = colonMatch.index + colonMatch[0].length;
    return { head: text.slice(0, idx), tail: text.slice(idx) };
  }

  return splitAtFirstSentenceBoundary(text);
}

export function hasSentenceBoundary(text: string): boolean {
  return splitAtFirstSentenceBoundary(text) != null;
}

export function isSentenceAwareInlineInsertKind(kind: string | null): boolean {
  return kind === "explore-activity" || kind === "edited" || kind === "bash" || kind === "subagent-activity";
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
