import type { ChatEvent } from "@codesymphony/shared-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeChatEventPayload(
  eventType: ChatEvent["type"],
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }

  if (eventType !== "tool.finished") {
    return payload;
  }

  const output = typeof payload.output === "string" ? payload.output : null;
  const error = typeof payload.error === "string" ? payload.error : null;
  if (!output || !error || output !== error) {
    return payload;
  }

  const { output: _output, ...rest } = payload;
  return rest;
}
