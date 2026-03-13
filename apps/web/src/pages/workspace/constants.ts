import type { ChatEvent } from "@codesymphony/shared-types";

export const EVENT_TYPES = [
  "message.delta",
  "thinking.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "permission.resolved",
  "question.requested",
  "question.answered",
  "question.dismissed",
  "plan.created",
  "plan.approved",
  "plan.revision_requested",
  "subagent.started",
  "subagent.finished",
  "chat.completed",
  "chat.failed",
] as const;

export const INLINE_TOOL_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "permission.resolved",
  "question.requested",
  "question.answered",
  "question.dismissed",
  "plan.created",
  "plan.approved",
  "plan.revision_requested",
  "subagent.started",
  "subagent.finished",
  "chat.failed",
]);

export const MAX_ORDER_INDEX = Number.MAX_SAFE_INTEGER;

export const READ_TOOL_PATTERN = /\b(read|open|cat)\b/i;
export const SEARCH_TOOL_PATTERN = /\b(glob|grep|search|find|list|scan|ls)\b/i;
export const EDIT_TOOL_NAME_PATTERN = /^(edit|multiedit|write)$/i;
export const MCP_TOOL_PATTERN = /\bmcp\b/i;
export const READ_PROMPT_PATTERN =
  /\b(read|open|show|cat|display|view|find|locate|buka\w*|lihat\w*|isi\w*|lengkap|full|ulang|repeat|cari\w*|temu\w*|kasih\s*tau)\b/i;
export const FILE_PATH_PATTERN = /(?:[~./\w-]+\/)?[\w.-]+\.[a-z0-9]{1,10}\b|readme(?:\.md)?\b/gi;
export const TRIM_FILE_TOKEN_PATTERN = /^[`"'([{<\s]+|[`"',.;:)\]}>/\\\s]+$/g;
export const SENTENCE_BOUNDARY_PATTERN = /[.!?](?:["')\]]+)?(?:\s+|$|(?=[A-Z]))/;
export const SENTENCE_BOUNDARY_SCAN_LIMIT = 280;
export const EXPLORE_BASH_COMMAND_PATTERN = /^\s*(ls|find|tree|du|wc|stat|file|head|tail|grep|rg)\b/i;
