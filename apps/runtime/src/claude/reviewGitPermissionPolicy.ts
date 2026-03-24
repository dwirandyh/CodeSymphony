import type { ChatThreadPermissionProfile } from "@codesymphony/shared-types";

const REVIEW_GIT_COMMAND_PATTERN = /^(git|gh|glab)(\s|$)/;
const REVIEW_GIT_HEREDOC_SUBSTITUTION_PATTERN = /\$\(\s*cat\s+<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))\r?\n[\s\S]*?\r?\n(?:\2|\3)\s*\)/g;
const REVIEW_GIT_HEREDOC_PLACEHOLDER = "__REVIEW_GIT_HEREDOC__";

export function isReviewGitCommand(command: string | null | undefined): boolean {
  if (typeof command !== "string") {
    return false;
  }

  const normalized = command.trim();
  if (normalized.length === 0 || normalized.includes("`") || /\$\([^)]*$/.test(normalized)) {
    return false;
  }

  const sanitized = normalized.replace(
    REVIEW_GIT_HEREDOC_SUBSTITUTION_PATTERN,
    REVIEW_GIT_HEREDOC_PLACEHOLDER,
  );
  if (/[\n\r]/.test(sanitized) || sanitized.includes("$(")) {
    return false;
  }

  const segments: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  const pushSegment = (): boolean => {
    const segment = current.trim();
    if (segment.length === 0) {
      return false;
    }

    segments.push(segment);
    current = "";
    return true;
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const nextChar = normalized[index + 1] ?? "";

    if (char === "\\") {
      current += char;
      if (nextChar) {
        current += nextChar;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      current += char;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "&" && nextChar === "&") {
      if (!pushSegment()) {
        return false;
      }
      index += 1;
      continue;
    }

    if (char === "|" && nextChar === "|") {
      if (!pushSegment()) {
        return false;
      }
      index += 1;
      continue;
    }

    if (char === ";") {
      if (!pushSegment()) {
        return false;
      }
      continue;
    }

    if (char === "|" || char === ">" || char === "<" || char === "&") {
      return false;
    }

    current += char;
  }

  if (quote || !pushSegment()) {
    return false;
  }

  return segments.every((segment) => REVIEW_GIT_COMMAND_PATTERN.test(segment));
}

export function shouldAutoAllowReviewGitPermission(args: {
  permissionProfile: ChatThreadPermissionProfile | undefined;
  isBash: boolean;
  command: string | null | undefined;
}): boolean {
  return args.permissionProfile === "review_git"
    && args.isBash
    && isReviewGitCommand(args.command);
}
