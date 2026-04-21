import type { Repository, Worktree } from "@codesymphony/shared-types";

export type ParsedFileLocation = {
  path: string;
  line: number | null;
  column: number | null;
};

function normalizePath(input: string): string {
  let normalized = input.trim().replaceAll("\\", "/");

  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/g, "");
  }

  if (/^[A-Za-z]:$/.test(normalized)) {
    normalized = `${normalized}/`;
  }

  const windowsDrive = /^([A-Za-z]):(\/.*)$/.exec(normalized);
  if (windowsDrive) {
    return `${windowsDrive[1].toLowerCase()}:${windowsDrive[2]}`;
  }

  return normalized;
}

function stripPrivatePrefix(input: string): string {
  if (input === "/private") return "/";
  if (input.startsWith("/private/")) return input.slice("/private".length);
  return input;
}

export function parseFileLocation(input: string): ParsedFileLocation {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      path: trimmed,
      line: null,
      column: null,
    };
  }

  let path = trimmed;
  let line: number | null = null;
  let column: number | null = null;

  const hashLocationMatch = /^(.*)#L(\d+)(?:C(\d+))?$/iu.exec(path);
  if (hashLocationMatch) {
    path = hashLocationMatch[1] ?? path;
    line = Number.parseInt(hashLocationMatch[2] ?? "", 10);
    column = hashLocationMatch[3] ? Number.parseInt(hashLocationMatch[3], 10) : null;
  } else {
    path = path.replace(/#.*$/u, "");
  }

  const lineColumnMatch = /^(.*\.[^/\\:#?]+):(\d+)(?::(\d+))?$/u.exec(path);
  if (lineColumnMatch) {
    path = lineColumnMatch[1] ?? path;
    line ??= Number.parseInt(lineColumnMatch[2] ?? "", 10);
    column ??= lineColumnMatch[3] ? Number.parseInt(lineColumnMatch[3], 10) : null;
  }

  return {
    path,
    line: Number.isFinite(line) && line && line > 0 ? line : null,
    column: Number.isFinite(column) && column && column > 0 ? column : null,
  };
}

export function stripFileLocationSuffix(input: string): string {
  return parseFileLocation(input).path;
}

export function serializeFileLocation(path: string, line?: number | null, column?: number | null): string {
  const normalizedLine = Number.isInteger(line) && (line ?? 0) > 0 ? line : null;
  const normalizedColumn = Number.isInteger(column) && (column ?? 0) > 0 ? column : null;
  if (!normalizedLine) {
    return path;
  }

  return `${path}#L${normalizedLine}${normalizedColumn ? `C${normalizedColumn}` : ""}`;
}

export function areLikelySameFsPath(a: string, b: string): boolean {
  const normalizedA = normalizePath(a);
  const normalizedB = normalizePath(b);

  if (normalizedA === normalizedB) return true;
  if (stripPrivatePrefix(normalizedA) === normalizedB) return true;
  if (normalizedA === stripPrivatePrefix(normalizedB)) return true;
  return false;
}

export function toWorktreeRelativePath(worktreePath: string, candidatePath: string): string | null {
  const normalizedRoot = stripPrivatePrefix(normalizePath(stripFileLocationSuffix(worktreePath)));
  const normalizedCandidate = stripPrivatePrefix(normalizePath(stripFileLocationSuffix(candidatePath)));

  if (normalizedCandidate === normalizedRoot) {
    return "";
  }

  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) {
    return null;
  }

  return normalizedCandidate.slice(normalizedRoot.length + 1);
}

export function resolveWorktreeRelativePath(
  worktreePath: string,
  candidatePath: string,
  knownRelativePaths: string[] = [],
): string | null {
  const directRelativePath = toWorktreeRelativePath(worktreePath, candidatePath);
  if (directRelativePath !== null) {
    return directRelativePath;
  }

  const normalizedCandidate = stripPrivatePrefix(normalizePath(stripFileLocationSuffix(candidatePath)));
  const suffixMatches = knownRelativePaths.filter((relativePath) => {
    const normalizedRelativePath = normalizePath(stripFileLocationSuffix(relativePath));
    return normalizedCandidate === normalizedRelativePath || normalizedCandidate.endsWith(`/${normalizedRelativePath}`);
  });

  if (suffixMatches.length !== 1) {
    return null;
  }

  return suffixMatches[0] ?? null;
}

export function isRootWorktree(worktree: Worktree, repository: Repository): boolean {
  return worktree.status === "active" && areLikelySameFsPath(worktree.path, repository.rootPath);
}

export function findRootWorktree(repository: Repository): Worktree | null {
  return repository.worktrees.find((worktree) => isRootWorktree(worktree, repository)) ?? null;
}
