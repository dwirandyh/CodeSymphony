import type { ChatEvent } from "@codesymphony/shared-types";
import { payloadStringOrNull } from "./eventUtils";
import type { SubagentGroup, SubagentStep } from "./types";

const MAX_LAST_MESSAGE_LENGTH = 2000;

function truncateLastMessage(message: string): string {
  if (message.length <= MAX_LAST_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_LAST_MESSAGE_LENGTH).trimEnd()}...`;
}

function buildStepLabel(event: ChatEvent): string {
  const toolName = payloadStringOrNull(event.payload.toolName);
  const summary = payloadStringOrNull(event.payload.summary);
  if (summary) {
    return summary;
  }
  if (toolName) {
    if (event.type === "tool.started") {
      return `${toolName} (running)`;
    }
    return toolName;
  }
  return "Step";
}

/**
 * Build a lookup from toolUseId -> parentToolUseId by scanning ALL tool events.
 *
 * The SDK's PreToolUse hook doesn't provide parent_tool_use_id, so tool.started
 * events arrive with parentToolUseId: null. The real parent is only known from
 * tool_progress (emitted as tool.output) which carries the correct value.
 * We scan every event to discover the relationship, then use it to group events.
 */
function buildParentLookup(events: ChatEvent[]): Map<string, string> {
  const parentByToolUseId = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
      continue;
    }
    const toolUseId = payloadStringOrNull(event.payload.toolUseId);
    const parentToolUseId = payloadStringOrNull(event.payload.parentToolUseId);
    if (toolUseId && parentToolUseId) {
      parentByToolUseId.set(toolUseId, parentToolUseId);
    }
  }
  return parentByToolUseId;
}

export function extractSubagentGroups(events: ChatEvent[]): SubagentGroup[] {
  const ordered = [...events].sort((a, b) => a.idx - b.idx);
  const groups: SubagentGroup[] = [];

  const parentByToolUseId = buildParentLookup(ordered);

  const activeSubagents = new Map<
    string,
    {
      agentId: string;
      agentType: string;
      toolUseId: string;
      description: string;
      startIdx: number;
      createdAt: string;
      startEventId: string;
      steps: SubagentStep[];
      eventIds: Set<string>;
    }
  >();

  for (const event of ordered) {
    if (event.type === "subagent.started") {
      const agentId = payloadStringOrNull(event.payload.agentId) ?? "";
      const agentType = payloadStringOrNull(event.payload.agentType) ?? "unknown";
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      const description = payloadStringOrNull(event.payload.description) ?? "";

      if (!toolUseId) {
        continue;
      }

      activeSubagents.set(toolUseId, {
        agentId,
        agentType,
        toolUseId,
        description,
        startIdx: event.idx,
        createdAt: event.createdAt,
        startEventId: event.id,
        steps: [],
        eventIds: new Set([event.id]),
      });
      continue;
    }

    if (event.type === "subagent.finished") {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      const lastMessage = payloadStringOrNull(event.payload.lastMessage) ?? "";
      const finishDescription = payloadStringOrNull(event.payload.description) ?? "";
      const subagent = activeSubagents.get(toolUseId);
      if (!subagent) {
        continue;
      }

      subagent.eventIds.add(event.id);

      // Use description from finish event (parsed from transcript) if start event had none
      const resolvedDescription = subagent.description || finishDescription;

      const startMs = Date.parse(subagent.createdAt);
      const endMs = Date.parse(event.createdAt);
      const durationSeconds =
        Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
          ? Math.max(1, Math.round((endMs - startMs) / 1000))
          : null;

      groups.push({
        id: `subagent:${subagent.startEventId}`,
        agentId: subagent.agentId,
        agentType: subagent.agentType,
        toolUseId: subagent.toolUseId,
        status: "success",
        description: resolvedDescription,
        lastMessage: truncateLastMessage(lastMessage),
        steps: subagent.steps,
        durationSeconds,
        startIdx: subagent.startIdx,
        anchorIdx: subagent.startIdx,
        createdAt: subagent.createdAt,
        eventIds: subagent.eventIds,
      });

      activeSubagents.delete(toolUseId);
      continue;
    }

    if (
      event.type === "tool.started" ||
      event.type === "tool.output" ||
      event.type === "tool.finished"
    ) {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? event.id;

      // Check if this event IS the Task tool itself (toolUseId matches a sub-agent's toolUseId).
      // These events represent the sub-agent launcher and should be claimed but not shown as steps.
      const ownerSubagent = activeSubagents.get(toolUseId);
      if (ownerSubagent) {
        ownerSubagent.eventIds.add(event.id);
        continue;
      }

      // Try explicit parent resolution first (parentToolUseId or buildParentLookup)
      const directParent = payloadStringOrNull(event.payload.parentToolUseId);
      let resolvedParent = directParent ?? parentByToolUseId.get(toolUseId) ?? null;

      // Fallback: Check if precedingToolUseIds contains an already-claimed child tool.
      if (!resolvedParent) {
        const precedingIds = Array.isArray(event.payload.precedingToolUseIds)
          ? event.payload.precedingToolUseIds.filter((id: unknown): id is string => typeof id === "string")
          : [];
        for (const pid of precedingIds) {
          if (activeSubagents.has(pid)) {
            resolvedParent = pid;
            parentByToolUseId.set(toolUseId, pid);
            break;
          }
          const parentFromPreceding = parentByToolUseId.get(pid);
          if (parentFromPreceding && activeSubagents.has(parentFromPreceding)) {
            resolvedParent = parentFromPreceding;
            parentByToolUseId.set(toolUseId, parentFromPreceding);
            break;
          }
        }
      }

      // Index-range fallback: if no explicit parent is found, check if this event falls
      // within any active subagent's index range. In real data, child tool events often
      // lack parentToolUseId entirely — the only signal is that they appear between
      // subagent.started and subagent.finished in the event stream.
      if (!resolvedParent) {
        for (const [saToolUseId, sa] of activeSubagents) {
          if (event.idx > sa.startIdx) {
            resolvedParent = saToolUseId;
            parentByToolUseId.set(toolUseId, saToolUseId);
            break;
          }
        }
      }

      if (!resolvedParent) {
        continue;
      }

      const subagent = activeSubagents.get(resolvedParent);
      if (!subagent) {
        continue;
      }

      subagent.eventIds.add(event.id);

      // tool.finished events often use a DIFFERENT toolUseId than the corresponding
      // tool.started event. They link back via precedingToolUseIds. We need to find
      // the existing "running" step and update it rather than creating a duplicate.
      const precedingIds = Array.isArray(event.payload.precedingToolUseIds)
        ? event.payload.precedingToolUseIds.filter((id: unknown): id is string => typeof id === "string")
        : [];

      let existingStep = subagent.steps.find((s) => s.toolUseId === toolUseId);

      // Fallback: match via precedingToolUseIds (tool.finished → tool.started linkage)
      if (!existingStep && precedingIds.length > 0) {
        existingStep = subagent.steps.find((s) => precedingIds.includes(s.toolUseId));
      }

      if (existingStep) {
        if (event.type === "tool.finished") {
          existingStep.status = "success";
          existingStep.label = buildStepLabel(event);
          // Update toolUseId to the finished event's ID so future lookups work
          existingStep.toolUseId = toolUseId;
        } else if (event.type === "tool.output" && existingStep.status === "running") {
          existingStep.label = buildStepLabel(event);
        }
      } else {
        subagent.steps.push({
          toolUseId,
          toolName: payloadStringOrNull(event.payload.toolName) ?? "Tool",
          label: buildStepLabel(event),
          status: event.type === "tool.finished" ? "success" : "running",
        });
      }
    }
  }

  for (const subagent of activeSubagents.values()) {
    groups.push({
      id: `subagent:${subagent.startEventId}`,
      agentId: subagent.agentId,
      agentType: subagent.agentType,
      toolUseId: subagent.toolUseId,
      status: "running",
      description: subagent.description,
      lastMessage: null,
      steps: subagent.steps,
      durationSeconds: null,
      startIdx: subagent.startIdx,
      anchorIdx: subagent.startIdx,
      createdAt: subagent.createdAt,
      eventIds: subagent.eventIds,
    });
  }

  return groups.sort((a, b) => a.startIdx - b.startIdx);
}
