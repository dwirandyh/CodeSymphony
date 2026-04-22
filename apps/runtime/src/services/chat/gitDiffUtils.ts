import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile as execFileRaw } from "node:child_process";
import { promisify } from "node:util";
import type { ParsedDiffSections, WorktreeDiffDelta, WorktreeStateSnapshot } from "./chatService.types.js";

const execFile = promisify(execFileRaw);
const MAX_DIFF_PREVIEW_CHARS = 20000;

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
  });

  return stdout.trim();
}

function parseChangedFiles(statusOutput: string): string[] {
  if (statusOutput.length === 0) {
    return [];
  }

  const files = new Set<string>();
  for (const line of statusOutput.split("\n")) {
    const normalized = line.trimEnd();
    if (normalized.length === 0) {
      continue;
    }

    let path = "";
    if (normalized.startsWith("?? ") || normalized.startsWith("!! ")) {
      path = normalized.slice(3).trim();
    } else {
      const porcelainMatch = /^[ MADRCU?!][ MADRCU?!]\s+(.+)$/.exec(normalized);
      if (porcelainMatch?.[1]) {
        path = porcelainMatch[1].trim();
      } else {
        const fallbackParts = normalized.split(/\s+/, 2);
        if (fallbackParts.length === 2) {
          path = fallbackParts[1].trim();
        }
      }
    }

    if (path.length > 0) {
      files.add(path);
    }
  }

  return Array.from(files);
}

function parseDiffSections(diffOutput: string): ParsedDiffSections {
  const byFile = new Map<string, string>();
  const order: string[] = [];

  if (diffOutput.trim().length === 0) {
    return { byFile, order };
  }

  const lines = diffOutput.split(/\r?\n/);
  let currentFile: string | null = null;
  let currentLines: string[] = [];

  function flushCurrentSection(): void {
    if (!currentFile || currentLines.length === 0) {
      currentFile = null;
      currentLines = [];
      return;
    }

    const section = currentLines.join("\n").trimEnd();
    const existing = byFile.get(currentFile);
    if (!existing) {
      byFile.set(currentFile, section);
      order.push(currentFile);
    } else {
      byFile.set(currentFile, `${existing}\n\n${section}`);
    }

    currentFile = null;
    currentLines = [];
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushCurrentSection();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      currentFile = match?.[2] ?? null;
      currentLines = [line];
      continue;
    }

    if (!currentFile) {
      continue;
    }
    currentLines.push(line);
  }

  flushCurrentSection();
  return { byFile, order };
}

function appendUnique(items: string[], seen: Set<string>, candidate: string): void {
  if (seen.has(candidate)) {
    return;
  }
  seen.add(candidate);
  items.push(candidate);
}

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function toDirectoryPrefix(filePath: string): string {
  const normalized = normalizeGitPath(filePath);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function matchesTargetFile(filePath: string, targetFiles: string[]): boolean {
  const normalizedFilePath = normalizeGitPath(filePath);
  const filePathDirectoryPrefix = toDirectoryPrefix(normalizedFilePath);

  return targetFiles.some((target) => {
    const normalizedTarget = normalizeGitPath(target);
    const targetDirectoryPrefix = toDirectoryPrefix(normalizedTarget);
    return normalizedFilePath === normalizedTarget
      || normalizedFilePath.endsWith(`/${normalizedTarget}`)
      || normalizedTarget.endsWith(`/${normalizedFilePath}`)
      || normalizedFilePath.startsWith(targetDirectoryPrefix)
      || normalizedTarget.startsWith(filePathDirectoryPrefix);
  });
}

function symmetricStatusDelta(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const delta: string[] = [];
  const seen = new Set<string>();

  for (const file of after) {
    if (!beforeSet.has(file)) {
      appendUnique(delta, seen, file);
    }
  }
  for (const file of before) {
    if (!afterSet.has(file)) {
      appendUnique(delta, seen, file);
    }
  }

  return delta;
}

function mergeChangedFiles(statusFiles: string[], untrackedFilePaths: string[]): string[] {
  if (untrackedFilePaths.length === 0) {
    return statusFiles;
  }

  const merged: string[] = [];
  const seen = new Set<string>();

  for (const statusFile of statusFiles) {
    const statusDirectoryPrefix = toDirectoryPrefix(statusFile);
    const representedByUntrackedFile = untrackedFilePaths.some((untrackedFilePath) => (
      normalizeGitPath(untrackedFilePath).startsWith(statusDirectoryPrefix)
    ));
    if (representedByUntrackedFile) {
      continue;
    }
    appendUnique(merged, seen, normalizeGitPath(statusFile));
  }

  for (const untrackedFilePath of untrackedFilePaths) {
    appendUnique(merged, seen, normalizeGitPath(untrackedFilePath));
  }

  return merged;
}

async function listUntrackedFilePaths(worktreePath: string): Promise<string[]> {
  try {
    const output = await runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (output.length === 0) {
      return [];
    }

    return output
      .split("\u0000")
      .map((filePath) => normalizeGitPath(filePath))
      .filter((filePath) => filePath.length > 0);
  } catch {
    return [];
  }
}

function computeFileSignature(worktreePath: string, relativePath: string): string | null {
  try {
    const content = readFileSync(join(worktreePath, relativePath));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function captureUntrackedFileSignatures(worktreePath: string, untrackedFilePaths: string[]): Map<string, string> {
  const signatures = new Map<string, string>();

  for (const untrackedFilePath of untrackedFilePaths) {
    const signature = computeFileSignature(worktreePath, untrackedFilePath);
    if (!signature) {
      continue;
    }
    signatures.set(untrackedFilePath, signature);
  }

  return signatures;
}

function captureUntrackedFileContents(worktreePath: string, untrackedFilePaths: string[]): Map<string, string> {
  const contents = new Map<string, string>();

  for (const untrackedFilePath of untrackedFilePaths) {
    try {
      contents.set(untrackedFilePath, readFileSync(join(worktreePath, untrackedFilePath), "utf8"));
    } catch {
      continue;
    }
  }

  return contents;
}

function collectUntrackedDeltaFiles(
  beforeSignatures: Map<string, string>,
  afterSignatures: Map<string, string>,
): { current: string[]; all: string[] } {
  const current: string[] = [];
  const currentSeen = new Set<string>();
  const all: string[] = [];
  const allSeen = new Set<string>();
  const queue = [
    ...afterSignatures.keys(),
    ...Array.from(beforeSignatures.keys()).filter((filePath) => !afterSignatures.has(filePath)),
  ];

  for (const filePath of queue) {
    const beforeSignature = beforeSignatures.get(filePath) ?? null;
    const afterSignature = afterSignatures.get(filePath) ?? null;
    if (beforeSignature === afterSignature) {
      continue;
    }

    appendUnique(all, allSeen, filePath);
    if (afterSignature) {
      appendUnique(current, currentSeen, filePath);
    }
  }

  return { current, all };
}

export function filterDiffByFiles(diff: string, targetFiles: string[]): string {
  if (targetFiles.length === 0 || diff.length === 0) {
    return diff;
  }

  const sections: string[] = [];
  let currentLines: string[] = [];
  let include = false;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (include && currentLines.length > 0) {
        sections.push(currentLines.join("\n"));
      }
      currentLines = [line];
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      const filePath = match?.[2] ?? null;
      include = filePath != null && matchesTargetFile(filePath, targetFiles);
      continue;
    }

    currentLines.push(line);
  }

  if (include && currentLines.length > 0) {
    sections.push(currentLines.join("\n"));
  }

  return sections.join("\n");
}

export function filterChangedFilesByTargets(changedFiles: string[], targetFiles: string[]): string[] {
  if (targetFiles.length === 0) {
    return changedFiles;
  }

  return changedFiles.filter((filePath) => matchesTargetFile(filePath, targetFiles));
}

export function truncateDiffPreview(diff: string): { diff: string; diffTruncated: boolean } {
  const diffTruncated = diff.length > MAX_DIFF_PREVIEW_CHARS;
  return {
    diff: diffTruncated
      ? `${diff.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n\n... [diff truncated]`
      : diff,
    diffTruncated,
  };
}

export async function captureWorktreeState(worktreePath: string): Promise<WorktreeStateSnapshot | null> {
  try {
    const [statusOutput, unstagedDiff, stagedDiff, untrackedFilePaths] = await Promise.all([
      runGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"]),
      runGit(worktreePath, ["diff", "--no-color"]),
      runGit(worktreePath, ["diff", "--cached", "--no-color"]),
      listUntrackedFilePaths(worktreePath),
    ]);

    return {
      statusOutput,
      unstagedDiff,
      stagedDiff,
      changedFiles: mergeChangedFiles(parseChangedFiles(statusOutput), untrackedFilePaths),
      untrackedFileSignatures: captureUntrackedFileSignatures(worktreePath, untrackedFilePaths),
      untrackedFileContents: captureUntrackedFileContents(worktreePath, untrackedFilePaths),
    };
  } catch {
    return null;
  }
}

function splitDiffContentLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function renderSyntheticDiffSection(filePath: string, beforeContent: string | null, afterContent: string | null): string {
  const beforeLines = beforeContent == null ? [] : splitDiffContentLines(beforeContent);
  const afterLines = afterContent == null ? [] : splitDiffContentLines(afterContent);
  const beforeHeader = beforeLines.length === 0 ? "0,0" : beforeLines.length === 1 ? "1" : `1,${beforeLines.length}`;
  const afterHeader = afterLines.length === 0 ? "0,0" : afterLines.length === 1 ? "1" : `1,${afterLines.length}`;

  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    ...(beforeContent == null ? ["new file mode 100644"] : []),
    ...(afterContent == null ? ["deleted file mode 100644"] : []),
    `--- ${beforeContent == null ? "/dev/null" : `a/${filePath}`}`,
    `+++ ${afterContent == null ? "/dev/null" : `b/${filePath}`}`,
    `@@ -${beforeHeader} +${afterHeader} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];

  return lines.join("\n");
}

function buildUntrackedDiffDelta(
  beforeContents: Map<string, string>,
  afterContents: Map<string, string>,
  currentFiles: string[],
): string {
  if (currentFiles.length === 0) {
    return "";
  }

  return currentFiles
    .map((filePath) =>
      renderSyntheticDiffSection(filePath, beforeContents.get(filePath) ?? null, afterContents.get(filePath) ?? null))
    .join("\n\n");
}

export function buildDiffDelta(before: WorktreeStateSnapshot, after: WorktreeStateSnapshot): WorktreeDiffDelta | null {
  const beforeCombinedDiff = [before.unstagedDiff, before.stagedDiff].filter((part) => part.length > 0).join("\n\n");
  const afterCombinedDiff = [after.unstagedDiff, after.stagedDiff].filter((part) => part.length > 0).join("\n\n");
  const untrackedDeltaFiles = collectUntrackedDeltaFiles(before.untrackedFileSignatures, after.untrackedFileSignatures);

  if (
    before.statusOutput === after.statusOutput
    && beforeCombinedDiff === afterCombinedDiff
    && untrackedDeltaFiles.all.length === 0
  ) {
    return null;
  }

  const beforeSections = parseDiffSections(beforeCombinedDiff);
  const afterSections = parseDiffSections(afterCombinedDiff);

  const diffDeltaFiles = new Set<string>();
  const orderedDiffDeltaFiles: string[] = [];
  const allSectionFiles = new Set([
    ...beforeSections.byFile.keys(),
    ...afterSections.byFile.keys(),
  ]);

  for (const file of afterSections.order) {
    const beforeSection = beforeSections.byFile.get(file) ?? "";
    const afterSection = afterSections.byFile.get(file) ?? "";
    if (beforeSection !== afterSection) {
      diffDeltaFiles.add(file);
      orderedDiffDeltaFiles.push(file);
    }
  }
  for (const file of beforeSections.order) {
    if (diffDeltaFiles.has(file)) {
      continue;
    }
    const beforeSection = beforeSections.byFile.get(file) ?? "";
    const afterSection = afterSections.byFile.get(file) ?? "";
    if (beforeSection !== afterSection) {
      diffDeltaFiles.add(file);
      orderedDiffDeltaFiles.push(file);
    }
  }
  for (const file of allSectionFiles) {
    if (diffDeltaFiles.has(file)) {
      continue;
    }
    const beforeSection = beforeSections.byFile.get(file) ?? "";
    const afterSection = afterSections.byFile.get(file) ?? "";
    if (beforeSection !== afterSection) {
      diffDeltaFiles.add(file);
      orderedDiffDeltaFiles.push(file);
    }
  }

  const currentDiffFiles = orderedDiffDeltaFiles
    .filter((file) => (afterSections.byFile.get(file) ?? "").length > 0);
  const deltaSections = currentDiffFiles
    .map((file) => afterSections.byFile.get(file) ?? "")
    .filter((section) => section.length > 0);
  const untrackedDiffDelta = buildUntrackedDiffDelta(
    before.untrackedFileContents,
    after.untrackedFileContents,
    untrackedDeltaFiles.current,
  );
  const diffDelta = [...deltaSections, untrackedDiffDelta]
    .filter((section) => section.length > 0)
    .join("\n\n");

  const statusDeltaFiles = symmetricStatusDelta(before.changedFiles, after.changedFiles);
  const afterChangedFiles = new Set(after.changedFiles);
  const changedFiles: string[] = [];
  const changedFilesSeen = new Set<string>();
  for (const file of currentDiffFiles) {
    appendUnique(changedFiles, changedFilesSeen, file);
  }

  for (const file of statusDeltaFiles) {
    if (afterChangedFiles.has(file)) {
      appendUnique(changedFiles, changedFilesSeen, file);
    }
  }
  for (const file of untrackedDeltaFiles.current) {
    appendUnique(changedFiles, changedFilesSeen, file);
  }

  if (changedFiles.length === 0 && diffDelta.length === 0) {
    for (const file of orderedDiffDeltaFiles) {
      appendUnique(changedFiles, changedFilesSeen, file);
    }
    for (const file of statusDeltaFiles) {
      appendUnique(changedFiles, changedFilesSeen, file);
    }
    for (const file of untrackedDeltaFiles.all) {
      appendUnique(changedFiles, changedFilesSeen, file);
    }
  }

  if (changedFiles.length === 0 && diffDelta.length === 0) {
    return null;
  }

  const { diff, diffTruncated } = truncateDiffPreview(diffDelta);

  return {
    changedFiles,
    fullDiff: diffDelta,
    diff,
    diffTruncated,
  };
}
