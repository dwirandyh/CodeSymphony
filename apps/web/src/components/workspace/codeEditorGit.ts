import { parseDiffFromFile } from "@pierre/diffs";
import type { FileDiffMetadata, Hunk } from "@pierre/diffs";
import type { GitChangeStatus } from "@codesymphony/shared-types";

export type EditorGitChangeKind = "added" | "modified" | "deleted";

export type EditorGitLineDecoration = {
  lineNumber: number;
  kind: EditorGitChangeKind;
  hunkIndex: number;
};

export type EditorGitHunk = {
  index: number;
  kind: EditorGitChangeKind;
  anchorLine: number;
  startLine: number;
  endLine: number;
  draftStartLine: number;
  draftLineCount: number;
  additions: number;
  deletions: number;
  lineNumbers: number[];
  replacementLines: string[];
  peekPatch: string;
  metadata: Hunk;
};

export type EditorGitModel = {
  diff: FileDiffMetadata | null;
  hunks: EditorGitHunk[];
  lines: EditorGitLineDecoration[];
};

export function buildEditorGitPeekPatch(hunk: EditorGitHunk | null | undefined): string | null {
  return hunk?.peekPatch ?? null;
}

function clampLineNumber(lineNumber: number, totalLines: number) {
  const safeTotalLines = Math.max(totalLines, 1);
  return Math.min(Math.max(lineNumber, 1), safeTotalLines);
}

function formatUnifiedCount(start: number, count: number) {
  if (count === 1) {
    return `${start}`;
  }

  if (count === 0) {
    return `${start},0`;
  }

  return `${start},${count}`;
}

function prefixDiffLines(prefix: " " | "+" | "-", lines: string[]) {
  return lines.map((line) => `${prefix}${line}`).join("");
}

function buildPeekPatch(args: {
  filePath: string;
  oldStart: number;
  newStart: number;
  contextBefore: string[];
  contextAfter: string[];
  additions: string[];
  deletions: string[];
}) {
  const oldCount = args.contextBefore.length + args.deletions.length + args.contextAfter.length;
  const newCount = args.contextBefore.length + args.additions.length + args.contextAfter.length;
  const lines = [
    `diff --git a/${args.filePath} b/${args.filePath}\n`,
    `--- a/${args.filePath}\n`,
    `+++ b/${args.filePath}\n`,
    `@@ -${formatUnifiedCount(args.oldStart, oldCount)} +${formatUnifiedCount(args.newStart, newCount)} @@\n`,
    prefixDiffLines(" ", args.contextBefore),
    prefixDiffLines("-", args.deletions),
    prefixDiffLines("+", args.additions),
    prefixDiffLines(" ", args.contextAfter),
  ];

  return lines.join("");
}

function splitEditorContentLines(content: string) {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export function buildEditorGitModel(
  filePath: string,
  headContent: string | null,
  draftContent: string,
): EditorGitModel {
  const diff = parseDiffFromFile(
    { name: filePath, contents: headContent ?? "" },
    { name: filePath, contents: draftContent },
  );

  if (diff.hunks.length === 0) {
    return {
      diff,
      hunks: [],
      lines: [],
    };
  }

  const lines: EditorGitLineDecoration[] = [];
  const hunks: EditorGitHunk[] = [];

  for (const originalHunk of diff.hunks) {
    let additionCursor = Math.max(originalHunk.additionStart, 1);
    let deletionCursor = Math.max(originalHunk.deletionStart, 1);
    let contextBefore: string[] = [];

    for (let index = 0; index < originalHunk.hunkContent.length; index += 1) {
      const content = originalHunk.hunkContent[index];
      if (content.type === "context") {
        additionCursor += content.lines.length;
        deletionCursor += content.lines.length;
        contextBefore = content.lines.slice(-3);
        continue;
      }

      const nextContent = originalHunk.hunkContent[index + 1];
      const contextAfter = nextContent?.type === "context" ? nextContent.lines.slice(0, 3) : [];
      const additions = content.additions.length;
      const deletions = content.deletions.length;
      const kind: EditorGitChangeKind = additions > 0 && deletions > 0
        ? "modified"
        : additions > 0
          ? "added"
          : "deleted";
      const draftStartLine = clampLineNumber(additionCursor, Math.max(diff.newLines?.length ?? 0, 1));
      const lineNumbers: number[] = [];

      if (additions > 0) {
        for (let offset = 0; offset < additions; offset += 1) {
          const lineNumber = additionCursor + offset;
          lineNumbers.push(lineNumber);
          lines.push({
            lineNumber,
            kind,
            hunkIndex: hunks.length,
          });
        }
      } else if (deletions > 0) {
        lineNumbers.push(draftStartLine);
      }

      const totalLines = Math.max(diff.newLines?.length ?? 0, draftContent === "" ? 1 : 0);
      const anchorLine = lineNumbers[0] ?? clampLineNumber(additionCursor, totalLines);
      const oldStart = Math.max(deletionCursor - contextBefore.length, 1);
      const newStart = Math.max(additionCursor - contextBefore.length, 1);
      const syntheticHunk: Hunk = {
        ...originalHunk,
        additionStart: newStart,
        additionLines: additions,
        deletionStart: oldStart,
        deletionLines: deletions,
        additionCount: contextBefore.length + additions + contextAfter.length,
        deletionCount: contextBefore.length + deletions + contextAfter.length,
        hunkContent: [
          ...(contextBefore.length > 0 ? [{ type: "context" as const, lines: contextBefore, noEOFCR: false }] : []),
          content,
          ...(contextAfter.length > 0 ? [{ type: "context" as const, lines: contextAfter, noEOFCR: false }] : []),
        ],
        hunkSpecs: `@@ -${formatUnifiedCount(oldStart, contextBefore.length + deletions + contextAfter.length)} +${formatUnifiedCount(newStart, contextBefore.length + additions + contextAfter.length)} @@\n`,
      };

      hunks.push({
        index: hunks.length,
        kind,
        anchorLine,
        startLine: lineNumbers[0] ?? anchorLine,
        endLine: lineNumbers[lineNumbers.length - 1] ?? anchorLine,
        draftStartLine,
        draftLineCount: additions,
        additions,
        deletions,
        lineNumbers,
        replacementLines: content.deletions,
        peekPatch: buildPeekPatch({
          filePath,
          oldStart,
          newStart,
          contextBefore,
          contextAfter,
          additions: content.additions,
          deletions: content.deletions,
        }),
        metadata: syntheticHunk,
      });

      additionCursor += additions;
      deletionCursor += deletions;
      contextBefore = [];
    }
  }

  return {
    diff,
    hunks,
    lines,
  };
}

export function findCurrentGitHunkIndex(hunks: EditorGitHunk[], cursorLine: number): number {
  if (hunks.length === 0) {
    return -1;
  }

  const containingHunk = hunks.findIndex((hunk) => cursorLine >= hunk.startLine && cursorLine <= hunk.endLine);
  if (containingHunk >= 0) {
    return containingHunk;
  }

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const hunk of hunks) {
    const distance = Math.abs(hunk.anchorLine - cursorLine);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = hunk.index;
    }
  }

  return nearestIndex;
}

export function deriveEditorGitStatus(
  gitStatus: GitChangeStatus | null | undefined,
  diff: FileDiffMetadata | null,
): GitChangeStatus | null {
  if (gitStatus) {
    return gitStatus;
  }

  if (!diff || diff.hunks.length === 0) {
    return null;
  }

  const oldLineCount = diff.oldLines?.length ?? 0;
  const newLineCount = diff.newLines?.length ?? 0;
  if (oldLineCount === 0 && newLineCount > 0) {
    return "added";
  }
  if (oldLineCount > 0 && newLineCount === 0) {
    return "deleted";
  }

  switch (diff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

export function revertEditorGitHunk(
  draftContent: string,
  hunk: EditorGitHunk | null | undefined,
): string {
  if (!hunk) {
    return draftContent;
  }

  const draftLines = splitEditorContentLines(draftContent);
  const startIndex = Math.max(hunk.draftStartLine - 1, 0);
  draftLines.splice(startIndex, hunk.draftLineCount, ...hunk.replacementLines);
  return draftLines.join("");
}
