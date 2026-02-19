/**
 * Shared mention token contract.
 *
 * Both Composer (serialization) and ChatMessageList (parsing/rendering)
 * must agree on the exact token format.  This module is the single
 * source of truth for that contract.
 */

/** Regex that matches a single mention token such as `@file:src/index.ts` or `@dir:src/utils`. */
export const MENTION_TOKEN_REGEX = /@(file|dir):([\w./_-][\w./_-]*[\w._-])/g;

export type MentionSegment =
  | { kind: "text"; value: string }
  | { kind: "mention"; path: string; name: string; isDirectory: boolean };

/**
 * Parse a message string into an array of text and mention segments.
 *
 * Used by ChatMessageList to render mention chips in user messages.
 */
export function parseUserMentions(content: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const regex = new RegExp(MENTION_TOKEN_REGEX.source, MENTION_TOKEN_REGEX.flags);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", value: content.slice(lastIndex, match.index) });
    }

    const typeTag = match[1];
    const fullPath = match[2];
    const name = fullPath.split("/").pop() ?? fullPath;
    segments.push({ kind: "mention", path: fullPath, name, isDirectory: typeTag === "dir" });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ kind: "text", value: content.slice(lastIndex) });
  }

  return segments;
}

/**
 * Serialize a single mention to its token form.
 *
 * Used by Composer when building the final message content.
 */
export function serializeMention(path: string, type: "file" | "directory"): string {
  return type === "directory" ? `@dir:${path}` : `@file:${path}`;
}

/**
 * Build the mention prefix string from an array of mentioned files.
 *
 * Used by Composer's `buildFinalContent`.
 */
export function serializeMentionPrefix(files: Array<{ path: string; type: "file" | "directory" }>): string {
  return files.map((f) => serializeMention(f.path, f.type)).join(" ");
}
