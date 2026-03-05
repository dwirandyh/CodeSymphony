import { execFile as execFileRaw } from "node:child_process";
import { promisify } from "node:util";
import type { ParsedDiffSections, WorktreeStateSnapshot } from "./chatService.types.js";

const execFile = promisify(execFileRaw);
const MAX_DIFF_PREVIEW_CHARS = 20000;

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
  });

  return stdout.trim();
}

export function parseChangedFiles(statusOutput: string): string[] {
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

export function parseDiffSections(diffOutput: string): ParsedDiffSections {
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

export function appendUnique(items: string[], seen: Set<string>, candidate: string): void {
  if (seen.has(candidate)) {
    return;
  }
  seen.add(candidate);
  items.push(candidate);
}

export function symmetricStatusDelta(before: string[], after: string[]): string[] {
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

export async function captureWorktreeState(worktreePath: string): Promise<WorktreeStateSnapshot | null> {
  try {
    const [statusOutput, unstagedDiff, stagedDiff] = await Promise.all([
      runGit(worktreePath, ["status", "--porcelain"]),
      runGit(worktreePath, ["diff", "--no-color"]),
      runGit(worktreePath, ["diff", "--cached", "--no-color"]),
    ]);

    return {
      statusOutput,
      unstagedDiff,
      stagedDiff,
      changedFiles: parseChangedFiles(statusOutput),
    };
  } catch {
    return null;
  }
}

export function buildDiffDelta(before: WorktreeStateSnapshot, after: WorktreeStateSnapshot): {
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
} | null {
  const beforeCombinedDiff = [before.unstagedDiff, before.stagedDiff].filter((part) => part.length > 0).join("\n\n");
  const afterCombinedDiff = [after.unstagedDiff, after.stagedDiff].filter((part) => part.length > 0).join("\n\n");

  if (before.statusOutput === after.statusOutput && beforeCombinedDiff === afterCombinedDiff) {
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

  const deltaSections = orderedDiffDeltaFiles
    .map((file) => afterSections.byFile.get(file) ?? "")
    .filter((section) => section.length > 0);
  const diffDelta = deltaSections.join("\n\n");

  const changedFiles: string[] = [];
  const changedFilesSeen = new Set<string>();
  for (const file of orderedDiffDeltaFiles) {
    appendUnique(changedFiles, changedFilesSeen, file);
  }

  for (const file of symmetricStatusDelta(before.changedFiles, after.changedFiles)) {
    appendUnique(changedFiles, changedFilesSeen, file);
  }

  if (changedFiles.length === 0 && diffDelta.length === 0) {
    return null;
  }

  const diffTruncated = diffDelta.length > MAX_DIFF_PREVIEW_CHARS;
  const diff = diffTruncated
    ? `${diffDelta.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n\n... [diff truncated]`
    : diffDelta;

  return {
    changedFiles,
    diff,
    diffTruncated,
  };
}
