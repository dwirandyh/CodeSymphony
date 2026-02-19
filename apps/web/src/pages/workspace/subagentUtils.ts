import type { ChatEvent } from "@codesymphony/shared-types";
import { payloadStringOrNull } from "./eventUtils";
import type { SubagentGroup, SubagentStep } from "./types";

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
  const debugLog: Record<string, unknown>[] = [];

  const parentByToolUseId = buildParentLookup(ordered);
  debugLog.push({ phase: "init", totalEvents: ordered.length, parentLookupSize: parentByToolUseId.size });

  // Map from Task tool toolUseId (e.g. call_9p7...) to subagent toolUseId (e.g. dd4ac7b3-...)
  // The PreToolUse hook stores the tool input keyed by the Task tool's call_* ID.
  // SubagentStart provides a different agent-level UUID. We need to bridge these.
  const taskToolToSubagent = new Map<string, string>();
  // Track the most recent "Task" tool.started toolUseId so we can link it when subagent.started arrives
  let lastTaskToolUseId: string | null = null;

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

  // Keep finished subagent data so that late-arriving tool.finished events
  // (from tool_use_summary) can still be claimed and not leak into the main timeline
  const finishedSubagentData = new Map<string, { steps: SubagentStep[]; eventIds: Set<string> }>();

  for (const event of ordered) {

    if (event.type === "tool.started") {
      const toolName = payloadStringOrNull(event.payload.toolName) ?? "";
      if (toolName.toLowerCase() === "task") {
        const tid = payloadStringOrNull(event.payload.toolUseId) ?? "";
        if (tid) {
          lastTaskToolUseId = tid;
        }
      }
    }

    if (event.type === "subagent.started") {
      const agentId = payloadStringOrNull(event.payload.agentId) ?? "";
      const agentType = payloadStringOrNull(event.payload.agentType) ?? "unknown";
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      const description = payloadStringOrNull(event.payload.description) ?? "";

      debugLog.push({ phase: "subagent.started", agentId, agentType, toolUseId, descriptionLen: description.length, descriptionPreview: description.slice(0, 100), eventId: event.id, idx: event.idx });

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

      // Link the most recent Task tool_started to this subagent
      if (lastTaskToolUseId) {
        taskToolToSubagent.set(lastTaskToolUseId, toolUseId);
        debugLog.push({ phase: "taskToolLink", taskToolId: lastTaskToolUseId, subagentId: toolUseId });
        lastTaskToolUseId = null;
      }
      continue;
    }

    if (event.type === "subagent.finished") {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? "";
      const lastMessage = payloadStringOrNull(event.payload.lastMessage) ?? "";
      const finishDescription = payloadStringOrNull(event.payload.description) ?? "";
      const subagent = activeSubagents.get(toolUseId);

      debugLog.push({
        phase: "subagent.finished",
        toolUseId,
        lastMessageLen: lastMessage.length,
        lastMessagePreview: lastMessage.slice(0, 200),
        finishDescriptionLen: finishDescription.length,
        finishDescriptionPreview: finishDescription.slice(0, 100),
        hasActiveSubagent: !!subagent,
        eventId: event.id,
        idx: event.idx,
        payloadKeys: Object.keys(event.payload),
      });

      if (!subagent) {
        // Handle response update from PostToolUse — arrives after SubagentStop already
        // moved this subagent to finishedSubagentData. Update the group's lastMessage.
        // The toolUseId may be either the subagent's UUID or the Task tool's call_* ID.
        const resolvedId = finishedSubagentData.has(toolUseId) ? toolUseId : taskToolToSubagent.get(toolUseId);
        debugLog.push({ phase: "subagent.finished.lateUpdate", toolUseId, resolvedId, lastMessageLen: lastMessage.length });
        if (lastMessage && resolvedId && finishedSubagentData.has(resolvedId)) {
          const group = [...groups].reverse().find((g) => g.toolUseId === resolvedId);
          if (group) {
            group.lastMessage = lastMessage;
            debugLog.push({ phase: "subagent.finished.lateUpdate.applied", groupId: group.id, newLastMessageLen: lastMessage.length });
          }
          finishedSubagentData.get(resolvedId)?.eventIds.add(event.id);
        }
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
        lastMessage: lastMessage || null,
        steps: subagent.steps,
        durationSeconds,
        startIdx: subagent.startIdx,
        anchorIdx: subagent.startIdx,
        createdAt: subagent.createdAt,
        eventIds: subagent.eventIds,
      });

      // Move to finished map so late events can still be claimed
      finishedSubagentData.set(toolUseId, { steps: subagent.steps, eventIds: subagent.eventIds });
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
      // Also check finished subagents — the Task tool's tool.finished arrives after subagent.finished
      const finishedOwner = finishedSubagentData.get(toolUseId);
      if (finishedOwner) {
        finishedOwner.eventIds.add(event.id);
        // The Task tool's tool.finished event (from PostToolUse) carries subagentResponse
        // which is the REAL final response — SubagentStop fires before the transcript is complete
        if (event.type === "tool.finished") {
          const subagentResponse = payloadStringOrNull(event.payload.subagentResponse);
          debugLog.push({ phase: "tool.finished.directOwner", toolUseId, hasSubagentResponse: !!subagentResponse, subagentResponseLen: subagentResponse?.length ?? 0, subagentResponsePreview: subagentResponse?.slice(0, 200) });
          if (subagentResponse) {
            const group = groups.find((g) => g.toolUseId === toolUseId);
            if (group) {
              group.lastMessage = subagentResponse;
            }
          }
        }
        continue;
      }

      // Check if this is a Task tool event whose call_* ID maps to a subagent UUID
      const mappedSubagentId = taskToolToSubagent.get(toolUseId);
      if (mappedSubagentId) {
        const mappedActive = activeSubagents.get(mappedSubagentId);
        if (mappedActive) {
          mappedActive.eventIds.add(event.id);
          continue;
        }
        const mappedFinished = finishedSubagentData.get(mappedSubagentId);
        if (mappedFinished) {
          mappedFinished.eventIds.add(event.id);
          if (event.type === "tool.finished") {
            const subagentResponse = payloadStringOrNull(event.payload.subagentResponse);
            debugLog.push({ phase: "tool.finished.mappedOwner", toolUseId, mappedSubagentId, hasSubagentResponse: !!subagentResponse, subagentResponseLen: subagentResponse?.length ?? 0 });
            if (subagentResponse) {
              const group = groups.find((g) => g.toolUseId === mappedSubagentId);
              if (group) {
                group.lastMessage = subagentResponse;
              }
            }
          }
          continue;
        }
      }

      // Also check precedingToolUseIds for the Task tool ID mapping
      if (event.type === "tool.finished" && !mappedSubagentId) {
        const precedingIds = Array.isArray(event.payload.precedingToolUseIds)
          ? event.payload.precedingToolUseIds.filter((id: unknown): id is string => typeof id === "string")
          : [];
        for (const pid of precedingIds) {
          const mapped = taskToolToSubagent.get(pid);
          if (mapped) {
            const finished = finishedSubagentData.get(mapped);
            if (finished) {
              finished.eventIds.add(event.id);
              const subagentResponse = payloadStringOrNull(event.payload.subagentResponse);
              if (subagentResponse) {
                const group = groups.find((g) => g.toolUseId === mapped);
                if (group) {
                  group.lastMessage = subagentResponse;
                }
              }
              break;
            }
          }
        }
      }

      // Try explicit parent resolution first (parentToolUseId or buildParentLookup)
      const directParent = payloadStringOrNull(event.payload.parentToolUseId);
      let resolvedParent = directParent ?? parentByToolUseId.get(toolUseId) ?? null;

      // Helper: check if a toolUseId belongs to any subagent (active or finished)
      const hasSubagent = (id: string) => activeSubagents.has(id) || finishedSubagentData.has(id);

      // Fallback: Check if precedingToolUseIds contains an already-claimed child tool.
      if (!resolvedParent) {
        const precedingIds = Array.isArray(event.payload.precedingToolUseIds)
          ? event.payload.precedingToolUseIds.filter((id: unknown): id is string => typeof id === "string")
          : [];
        for (const pid of precedingIds) {
          if (hasSubagent(pid)) {
            resolvedParent = pid;
            parentByToolUseId.set(toolUseId, pid);
            break;
          }
          const parentFromPreceding = parentByToolUseId.get(pid);
          if (parentFromPreceding && hasSubagent(parentFromPreceding)) {
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

      // Resolve subagent data from active or finished maps
      const subagent = activeSubagents.get(resolvedParent) ?? finishedSubagentData.get(resolvedParent);
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

  const sortedGroups = groups.sort((a, b) => a.startIdx - b.startIdx);



  return sortedGroups;
}
