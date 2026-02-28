import type { Repository, Worktree } from "@codesymphony/shared-types";

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

export function areLikelySameFsPath(a: string, b: string): boolean {
  const normalizedA = normalizePath(a);
  const normalizedB = normalizePath(b);

  if (normalizedA === normalizedB) return true;
  if (stripPrivatePrefix(normalizedA) === normalizedB) return true;
  if (normalizedA === stripPrivatePrefix(normalizedB)) return true;
  return false;
}

export function isRootWorktree(worktree: Worktree, repository: Repository): boolean {
  return worktree.status === "active" && areLikelySameFsPath(worktree.path, repository.rootPath);
}

export function findRootWorktree(repository: Repository): Worktree | null {
  return repository.worktrees.find((worktree) => isRootWorktree(worktree, repository)) ?? null;
}
