import type { ChatEvent } from "@codesymphony/shared-types";
import { isReadToolEvent, isSearchToolEvent, payloadStringOrNull } from "./eventUtils";
import {
  extractReadFileEntry,
  extractSearchEntryLabel,
  searchContextFromEvent,
  shortenReadTargetForDisplay,
} from "./exploreUtils";
import type { SubagentGroup, SubagentStep } from "./types";

function buildStepInfo(event: ChatEvent): { label: string; openPath: string | null } {
  const toolName = payloadStringOrNull(event.payload.toolName);
  const summary = payloadStringOrNull(event.payload.summary);

  // Read tools: show short basename instead of full path
  if (isReadToolEvent(event) && event.type === "tool.finished") {
    const entry = extractReadFileEntry(event);
    if (entry) {
      return { label: entry.label, openPath: entry.openPath };
    }
  }

  // Search tools (Glob/Grep/Search): normalize "Completed Glob" into "Searched Glob (pattern)"
  if (isSearchToolEvent(event) && event.type === "tool.finished") {
    const ctx = searchContextFromEvent(event);
    return { label: extractSearchEntryLabel(event, { toolName: ctx.toolName, searchParams: ctx.searchParams }), openPath: null };
  }

  if (summary) {
    // Shorten absolute paths in summaries (e.g. Bash "Ran ls -R /full/path" → "Ran ls -R dir")
    const shortened = summary.replace(
      /"(\/[^"]+)"|'(\/[^']+)'|(\/(?:[^\s,]+\/)+[^\s,]+)/g,
      (match, quoted1: string | undefined, quoted2: string | undefined, unquoted: string | undefined) => {
        const p = quoted1 ?? quoted2 ?? unquoted ?? match;
        const short = shortenReadTargetForDisplay(p);
        if (quoted1) return `"${short}"`;
        if (quoted2) return `'${short}'`;
        return short;
      },
    );
    return { label: shortened, openPath: null };
  }
  if (toolName) {
    if (event.type === "tool.started") {
      return { label: `${toolName} (running)`, openPath: null };
    }
    return { label: toolName, openPath: null };
  }
  return { label: "Step", openPath: null };
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
  // Queue Task tool.starts so overlaps map deterministically to the next subagent.started.
  const pendingTaskStarts: Array<{ taskToolUseId: string; event: ChatEvent }> = [];

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

  const hasSubagent = (id: string) => activeSubagents.has(id) || finishedSubagentData.has(id);

  const normalizeOwnerCandidate = (candidate: string | null | undefined): string | null => {
    if (!candidate) {
      return null;
    }

    if (hasSubagent(candidate)) {
      return candidate;
    }

    const mapped = taskToolToSubagent.get(candidate);
    if (mapped && hasSubagent(mapped)) {
      return mapped;
    }

    return null;
  };

  const resolveOwnerToolUseId = (event: ChatEvent, toolUseId: string): string | null => {
    // 1) direct owner
    const directOwner = normalizeOwnerCandidate(toolUseId);
    if (directOwner) {
      return directOwner;
    }

    // 2) parent lineage: parentToolUseId + parent cache
    const parentCandidates = new Set<string>();
    const directParent = payloadStringOrNull(event.payload.parentToolUseId);
    const parentFromLookup = parentByToolUseId.get(toolUseId) ?? null;

    const normalizedDirectParent = normalizeOwnerCandidate(directParent);
    if (normalizedDirectParent) {
      parentCandidates.add(normalizedDirectParent);
    }

    const normalizedLookupParent = normalizeOwnerCandidate(parentFromLookup);
    if (normalizedLookupParent) {
      parentCandidates.add(normalizedLookupParent);
    }

    if (parentCandidates.size > 1) {
      return null;
    }

    if (parentCandidates.size === 1) {
      const [resolvedParent] = [...parentCandidates];
      if (resolvedParent && resolvedParent !== toolUseId) {
        parentByToolUseId.set(toolUseId, resolvedParent);
      }
      return resolvedParent ?? null;
    }

    // 3) precedingToolUseIds lineage
    const precedingIds = Array.isArray(event.payload.precedingToolUseIds)
      ? event.payload.precedingToolUseIds.filter((id: unknown): id is string => typeof id === "string")
      : [];

    const precedingCandidates = new Set<string>();
    for (const precedingId of precedingIds) {
      const normalizedPreceding = normalizeOwnerCandidate(precedingId);
      if (normalizedPreceding) {
        precedingCandidates.add(normalizedPreceding);
      }

      const parentFromPreceding = parentByToolUseId.get(precedingId);
      const normalizedParentFromPreceding = normalizeOwnerCandidate(parentFromPreceding);
      if (normalizedParentFromPreceding) {
        precedingCandidates.add(normalizedParentFromPreceding);
      }
    }

    if (precedingCandidates.size > 1) {
      return null;
    }

    if (precedingCandidates.size === 1) {
      const [resolvedFromPreceding] = [...precedingCandidates];
      if (resolvedFromPreceding && resolvedFromPreceding !== toolUseId) {
        parentByToolUseId.set(toolUseId, resolvedFromPreceding);
      }
      return resolvedFromPreceding ?? null;
    }

    // 4) index fallback only when exactly one active subagent exists
    if (activeSubagents.size === 1) {
      const onlyActiveToolUseId = activeSubagents.keys().next().value;
      if (typeof onlyActiveToolUseId === "string" && onlyActiveToolUseId !== toolUseId) {
        parentByToolUseId.set(toolUseId, onlyActiveToolUseId);
        return onlyActiveToolUseId;
      }
    }

    // 5) ambiguous/no lineage -> do not claim
    return null;
  };

  for (const event of ordered) {

    if (event.type === "tool.started") {
      const toolName = payloadStringOrNull(event.payload.toolName) ?? "";
      if (toolName.toLowerCase() === "task") {
        const tid = payloadStringOrNull(event.payload.toolUseId) ?? "";
        if (tid) {
          pendingTaskStarts.push({ taskToolUseId: tid, event });
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

      // Link the next pending Task tool.started to this subagent (FIFO for overlap safety)
      const pendingTaskStart = pendingTaskStarts.shift();
      if (pendingTaskStart) {
        taskToolToSubagent.set(pendingTaskStart.taskToolUseId, toolUseId);
        debugLog.push({ phase: "taskToolLink", taskToolId: pendingTaskStart.taskToolUseId, subagentId: toolUseId });
        activeSubagents.get(toolUseId)?.eventIds.add(pendingTaskStart.event.id);
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

      const ownerToolUseId = resolveOwnerToolUseId(event, toolUseId);
      if (!ownerToolUseId) {
        continue;
      }

      if (ownerToolUseId !== toolUseId) {
        parentByToolUseId.set(toolUseId, ownerToolUseId);
      }

      const subagent = activeSubagents.get(ownerToolUseId) ?? finishedSubagentData.get(ownerToolUseId);
      if (!subagent) {
        continue;
      }

      subagent.eventIds.add(event.id);

      const precedingIds = Array.isArray(event.payload.precedingToolUseIds)
        ? event.payload.precedingToolUseIds.filter((id: unknown): id is string => typeof id === "string")
        : [];
      const toolName = payloadStringOrNull(event.payload.toolName) ?? "";
      const taskMappedOwner = taskToolToSubagent.get(toolUseId);
      const hasMappedPrecedingOwner = precedingIds.some((precedingId) => taskToolToSubagent.get(precedingId) === ownerToolUseId);
      const subagentResponse = event.type === "tool.finished"
        ? payloadStringOrNull(event.payload.subagentResponse)
        : null;
      const isTaskLauncherEvent =
        toolUseId === ownerToolUseId
        || taskMappedOwner === ownerToolUseId
        || hasMappedPrecedingOwner
        || toolName.toLowerCase() === "task"
        || !!subagentResponse;

      if (isTaskLauncherEvent) {
        if (subagentResponse) {
          const group = groups.find((g) => g.toolUseId === ownerToolUseId);
          if (group) {
            group.lastMessage = subagentResponse;
          }
        }
        continue;
      }

      // tool.finished events often use a DIFFERENT toolUseId than the corresponding
      // tool.started event. They link back via precedingToolUseIds. We need to find
      // the existing "running" step and update it rather than creating a duplicate.

      let existingStep = subagent.steps.find((s) => s.toolUseId === toolUseId);

      // Fallback: match via precedingToolUseIds (tool.finished → tool.started linkage)
      if (!existingStep && precedingIds.length > 0) {
        existingStep = subagent.steps.find((s) => precedingIds.includes(s.toolUseId));
      }

      if (existingStep) {
        if (event.type === "tool.finished") {
          existingStep.status = "success";
          const info = buildStepInfo(event);
          existingStep.label = info.label;
          existingStep.openPath = info.openPath;
          // Update toolUseId to the finished event's ID so future lookups work
          existingStep.toolUseId = toolUseId;
        } else if (event.type === "tool.output" && existingStep.status === "running") {
          const info = buildStepInfo(event);
          existingStep.label = info.label;
          existingStep.openPath = info.openPath;
        }
      } else {
        const info = buildStepInfo(event);
        subagent.steps.push({
          toolUseId,
          toolName: payloadStringOrNull(event.payload.toolName) ?? "Tool",
          label: info.label,
          openPath: info.openPath,
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

