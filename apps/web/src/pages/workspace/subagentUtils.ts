import type { ChatEvent } from "@codesymphony/shared-types";
import { pushRenderDebug } from "../../lib/renderDebug";
import { isExploreLikeBashCommand, isReadToolEvent, isSearchToolEvent, payloadStringOrNull } from "./eventUtils";
import {
  extractReadFileEntry,
  extractSearchEntryLabel,
  searchContextFromEvent,
  shortenReadTargetForDisplay,
} from "./exploreUtils";
import type { SubagentGroup, SubagentStep } from "./types";

export type SubagentAttributionReasonCode =
  | "claimed_explicit_owner"
  | "claimed_parent_lineage"
  | "claimed_preceding_lineage"
  | "claimed_single_active_fallback"
  | "claimed_runtime_description_hint"
  | "unclaimed_ambiguous_parent_candidates"
  | "unclaimed_ambiguous_preceding_candidates"
  | "unclaimed_overlap_no_lineage"
  | "unclaimed_no_lineage";

const attributionReasonByEventId = new Map<string, SubagentAttributionReasonCode>();
const overlapCandidateEventIds = new Set<string>();

export function getSubagentAttributionReason(eventId: string): SubagentAttributionReasonCode | null {
  return attributionReasonByEventId.get(eventId) ?? null;
}

export function isOverlapUnclaimedSubagentEvent(eventId: string): boolean {
  return overlapCandidateEventIds.has(eventId);
}

function buildStepInfo(event: ChatEvent): { label: string; openPath: string | null } {
  const toolName = payloadStringOrNull(event.payload.toolName);
  const normalizedToolName = toolName?.trim().toLowerCase() ?? "";
  const summary = payloadStringOrNull(event.payload.summary);
  const command = payloadStringOrNull(event.payload.command)
    ?? (typeof event.payload.toolInput === "object" && event.payload.toolInput != null && !Array.isArray(event.payload.toolInput)
      ? payloadStringOrNull((event.payload.toolInput as Record<string, unknown>).command)
      : null);

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

  if (normalizedToolName === "bash" && command) {
    const shortenedCommand = command.replace(
      /"(\/[^\"]+)"|'(\/[^']+)'|(\/(?:[^\s,]+\/)+[^\s,]+)/g,
      (match, quoted1: string | undefined, quoted2: string | undefined, unquoted: string | undefined) => {
        const p = quoted1 ?? quoted2 ?? unquoted ?? match;
        const short = shortenReadTargetForDisplay(p);
        if (quoted1) return `"${short}"`;
        if (quoted2) return `'${short}'`;
        return short;
      },
    );
    return { label: shortenedCommand, openPath: null };
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
function isSubagentLauncherToolName(toolName: string | null): boolean {
  const normalized = (toolName ?? "").trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}

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

function buildExplicitOwnerHintLookup(events: ChatEvent[]): Map<string, string[]> {
  const ownerHintsByToolUseId = new Map<string, Set<string>>();

  const rememberHint = (toolUseId: string | null, ownerCandidate: string | null): void => {
    if (!toolUseId || !ownerCandidate) {
      return;
    }
    const existing = ownerHintsByToolUseId.get(toolUseId) ?? new Set<string>();
    existing.add(ownerCandidate);
    ownerHintsByToolUseId.set(toolUseId, existing);
  };

  const resolveSkillPathHints = (description: string): string[] => {
    const normalized = description.trim().toLowerCase();
    if (normalized.length === 0) {
      return [];
    }

    const hints = new Set<string>();
    for (const match of normalized.matchAll(/\b([a-z0-9][a-z0-9-]{1,})\s+skill\b/g)) {
      const slug = match[1]?.trim();
      if (!slug) {
        continue;
      }
      hints.add(`.claude/skills/${slug}`);
      hints.add(`claude/skills/${slug}`);
      hints.add(`skills/${slug}`);
      hints.add(`${slug}/skill.md`);
    }
    return [...hints];
  };

  const buildSubagentDescriptionHintLookup = () => {
    const descriptionHintsBySubagentId = new Map<string, string[]>();
    for (const event of events) {
      if (event.type !== "subagent.started" && event.type !== "subagent.finished") {
        continue;
      }
      const toolUseId = payloadStringOrNull(event.payload.toolUseId);
      const description = payloadStringOrNull(event.payload.description);
      if (!toolUseId || !description) {
        continue;
      }
      const hints = resolveSkillPathHints(description);
      if (hints.length > 0) {
        descriptionHintsBySubagentId.set(toolUseId, hints);
      }
    }
    return descriptionHintsBySubagentId;
  };

  const subagentDescriptionHintsById = buildSubagentDescriptionHintLookup();

  for (const event of events) {
    if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
      continue;
    }

    const ownerCandidate = payloadStringOrNull(event.payload.subagentOwnerToolUseId)
      ?? payloadStringOrNull(event.payload.launcherToolUseId);
    if (!ownerCandidate) {
      continue;
    }

    const toolUseId = payloadStringOrNull(event.payload.toolUseId);
    rememberHint(toolUseId, ownerCandidate);

    if (event.type === "tool.finished" && Array.isArray(event.payload.precedingToolUseIds)) {
      for (const precedingId of event.payload.precedingToolUseIds) {
        if (typeof precedingId !== "string") {
          continue;
        }
        rememberHint(precedingId, ownerCandidate);
      }
    }

    if (!ownerCandidate) {
      continue;
    }

    const commandOrSearchTarget = [
      payloadStringOrNull(event.payload.command),
      payloadStringOrNull(event.payload.searchParams),
      payloadStringOrNull(event.payload.summary),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ")
      .toLowerCase();

    if (commandOrSearchTarget.length === 0) {
      continue;
    }

    for (const [subagentToolUseId, hints] of subagentDescriptionHintsById.entries()) {
      if (!hints.some((hint) => commandOrSearchTarget.includes(hint))) {
        continue;
      }
      const normalizedOwner = ownerCandidate === subagentToolUseId ? ownerCandidate : subagentToolUseId;
      const toolUseId = payloadStringOrNull(event.payload.toolUseId);
      rememberHint(toolUseId, normalizedOwner);
      if (event.type === "tool.finished" && Array.isArray(event.payload.precedingToolUseIds)) {
        for (const precedingId of event.payload.precedingToolUseIds) {
          if (typeof precedingId !== "string") {
            continue;
          }
          rememberHint(precedingId, normalizedOwner);
        }
      }
    }
  }

  const lookup = new Map<string, string[]>();
  for (const [toolUseId, ownerCandidates] of ownerHintsByToolUseId.entries()) {
    lookup.set(toolUseId, [...ownerCandidates]);
  }

  return lookup;
}

export function extractSubagentGroups(events: ChatEvent[]): SubagentGroup[] {
  const ordered = [...events].sort((a, b) => a.idx - b.idx);
  const groups: SubagentGroup[] = [];
  const debugLog: Record<string, unknown>[] = [];

  for (const event of ordered) {
    attributionReasonByEventId.delete(event.id);
    overlapCandidateEventIds.delete(event.id);
  }

  const parentByToolUseId = buildParentLookup(ordered);
  const explicitOwnerHintByToolUseId = buildExplicitOwnerHintLookup(ordered);
  debugLog.push({ phase: "init", totalEvents: ordered.length, parentLookupSize: parentByToolUseId.size, explicitOwnerHintSize: explicitOwnerHintByToolUseId.size });

  // Map from Task tool toolUseId (e.g. call_9p7...) to subagent toolUseId (e.g. dd4ac7b3-...)
  // The PreToolUse hook stores the tool input keyed by the Task tool's call_* ID.
  // SubagentStart provides a different agent-level UUID. We need to bridge these.
  const taskToolToSubagent = new Map<string, string>();
  // Queue Task tool.starts so overlaps map deterministically to the next subagent.started.
  const pendingTaskStarts: Array<{ taskToolUseId: string; event: ChatEvent }> = [];
  const permissionOwnerByRequestId = new Map<string, string>();

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

  const markReason = (eventId: string, reason: SubagentAttributionReasonCode): void => {
    attributionReasonByEventId.set(eventId, reason);
  };

  const resolveOwnerToolUseId = (
    event: ChatEvent,
    toolUseId: string,
    options?: { allowSingleActiveFallback?: boolean },
  ): string | null => {
    // 1) explicit canonical owner from runtime payload
    const explicitOwner = normalizeOwnerCandidate(payloadStringOrNull(event.payload.subagentOwnerToolUseId));
    if (explicitOwner) {
      markReason(event.id, "claimed_explicit_owner");
      return explicitOwner;
    }

    // 2) explicit launcher id that may bridge to canonical subagent
    const launcherOwner = normalizeOwnerCandidate(payloadStringOrNull(event.payload.launcherToolUseId));
    if (launcherOwner) {
      markReason(event.id, "claimed_explicit_owner");
      return launcherOwner;
    }

    // 3) direct owner
    const directOwner = normalizeOwnerCandidate(toolUseId);
    if (directOwner) {
      markReason(event.id, "claimed_explicit_owner");
      return directOwner;
    }

    // 4) explicit owner hint cache (including preceding tool-use IDs from finished events)
    const explicitOwnerCandidates = new Set<string>();
    const hintedOwners = explicitOwnerHintByToolUseId.get(toolUseId) ?? [];
    for (const hintedOwner of hintedOwners) {
      const normalizedHintedOwner = normalizeOwnerCandidate(hintedOwner);
      if (normalizedHintedOwner) {
        explicitOwnerCandidates.add(normalizedHintedOwner);
      }
    }

    if (explicitOwnerCandidates.size > 1) {
      markReason(event.id, "unclaimed_ambiguous_parent_candidates");
      pushRenderDebug({
        source: "subagentUtils",
        event: "ambiguousOwner",
        details: {
          phase: "explicitOwnerHints",
          toolUseId,
          candidates: [...explicitOwnerCandidates],
          eventId: event.id,
          idx: event.idx,
          reasonCode: "unclaimed_ambiguous_parent_candidates",
        },
      });
      return null;
    }

    if (explicitOwnerCandidates.size === 1) {
      const [resolvedExplicitHintOwner] = [...explicitOwnerCandidates];
      if (resolvedExplicitHintOwner && resolvedExplicitHintOwner !== toolUseId) {
        parentByToolUseId.set(toolUseId, resolvedExplicitHintOwner);
      }
      markReason(event.id, "claimed_explicit_owner");
      return resolvedExplicitHintOwner ?? null;
    }

    // 5) parent lineage: parentToolUseId + parent cache
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
      markReason(event.id, "unclaimed_ambiguous_parent_candidates");
      pushRenderDebug({
        source: "subagentUtils",
        event: "ambiguousOwner",
        details: {
          phase: "parentCandidates",
          toolUseId,
          candidates: [...parentCandidates],
          eventId: event.id,
          idx: event.idx,
          reasonCode: "unclaimed_ambiguous_parent_candidates",
        },
      });
      return null;
    }

    if (parentCandidates.size === 1) {
      markReason(event.id, "claimed_parent_lineage");
      const [resolvedParent] = [...parentCandidates];
      if (resolvedParent && resolvedParent !== toolUseId) {
        parentByToolUseId.set(toolUseId, resolvedParent);
      }
      return resolvedParent ?? null;
    }

    // 6) precedingToolUseIds lineage
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
      markReason(event.id, "unclaimed_ambiguous_preceding_candidates");
      pushRenderDebug({
        source: "subagentUtils",
        event: "ambiguousOwner",
        details: {
          phase: "precedingCandidates",
          toolUseId,
          candidates: [...precedingCandidates],
          eventId: event.id,
          idx: event.idx,
          reasonCode: "unclaimed_ambiguous_preceding_candidates",
        },
      });
      return null;
    }

    if (precedingCandidates.size === 1) {
      markReason(event.id, "claimed_preceding_lineage");
      const [resolvedFromPreceding] = [...precedingCandidates];
      if (resolvedFromPreceding && resolvedFromPreceding !== toolUseId) {
        parentByToolUseId.set(toolUseId, resolvedFromPreceding);
      }
      return resolvedFromPreceding ?? null;
    }

    // 7) index fallback only when exactly one active subagent exists and explicitly allowed
    if (options?.allowSingleActiveFallback === true && activeSubagents.size === 1) {
      const onlyActiveToolUseId = activeSubagents.keys().next().value;
      if (typeof onlyActiveToolUseId === "string" && onlyActiveToolUseId !== toolUseId) {
        markReason(event.id, "claimed_single_active_fallback");
        parentByToolUseId.set(toolUseId, onlyActiveToolUseId);
        return onlyActiveToolUseId;
      }
    }

    // 8) ambiguous/no lineage -> do not claim
    markReason(event.id, "unclaimed_no_lineage");
    return null;
  };

  for (const event of ordered) {

    if (event.type === "tool.started") {
      const toolName = payloadStringOrNull(event.payload.toolName) ?? "";
      if (isSubagentLauncherToolName(toolName)) {
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
        pushRenderDebug({
          source: "subagentUtils",
          event: "lateSubagentUpdate",
          details: {
            toolUseId,
            resolvedId,
            lastMessageLen: lastMessage.length,
            eventId: event.id,
            idx: event.idx,
          },
        });
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

      if (subagent.steps.length > 0 && resolvedDescription.trim().length === 0) {
        pushRenderDebug({
          source: "subagentUtils",
          event: "subagentMissingDescription",
          details: {
            toolUseId,
            stepCount: subagent.steps.length,
            finishDescriptionLen: finishDescription.length,
            lastMessageLen: lastMessage.length,
            eventId: event.id,
            idx: event.idx,
          },
        });
      }

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

      const ownerToolUseId = resolveOwnerToolUseId(event, toolUseId, { allowSingleActiveFallback: true });
      if (!ownerToolUseId) {
        const existingReasonCode = getSubagentAttributionReason(event.id);
        if (!existingReasonCode || existingReasonCode === "unclaimed_no_lineage") {
          const runtimeOwnershipReason = payloadStringOrNull(event.payload.ownershipReason);
          if (runtimeOwnershipReason === "unresolved_ambiguous_candidates") {
            markReason(event.id, "unclaimed_ambiguous_parent_candidates");
            overlapCandidateEventIds.add(event.id);
          } else if (runtimeOwnershipReason === "unresolved_overlap_no_lineage") {
            markReason(event.id, "unclaimed_overlap_no_lineage");
            overlapCandidateEventIds.add(event.id);
          } else if (runtimeOwnershipReason === "resolved_subagent_description_hint" || runtimeOwnershipReason === "resolved_subagent_path_hint") {
            markReason(event.id, "claimed_runtime_description_hint");
          }
        }
        const reasonCode = getSubagentAttributionReason(event.id);
        if (reasonCode) {
          pushRenderDebug({
            source: "subagentUtils",
            event: "unclaimedToolEvent",
            details: {
              eventId: event.id,
              idx: event.idx,
              toolUseId,
              reasonCode,
            },
          });
        }
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
        || isSubagentLauncherToolName(toolName)
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
          const normalizedToolName = (payloadStringOrNull(event.payload.toolName) ?? "").trim().toLowerCase();
          const normalizedLabel = info.label.trim().toLowerCase();
          const preserveExistingBashLabel = normalizedToolName === "bash"
            && normalizedLabel === "completed bash"
            && isExploreLikeBashCommand(existingStep.label);
          if (!preserveExistingBashLabel) {
            existingStep.label = info.label;
            existingStep.openPath = info.openPath;
          }
          // Update toolUseId to the finished event's ID so future lookups work
          existingStep.toolUseId = toolUseId;
        } else if (event.type === "tool.output" && existingStep.status === "running") {
          const info = buildStepInfo(event);
          const normalizedToolName = (payloadStringOrNull(event.payload.toolName) ?? "").trim().toLowerCase();
          const preserveExistingBashLabel = normalizedToolName === "bash"
            && !isExploreLikeBashCommand(info.label)
            && isExploreLikeBashCommand(existingStep.label);
          if (!preserveExistingBashLabel) {
            existingStep.label = info.label;
            existingStep.openPath = info.openPath;
          }
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
      continue;
    }

    if (event.type === "permission.requested" || event.type === "permission.resolved") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      let ownerToolUseId: string | null = null;

      if (event.type === "permission.requested") {
        const explicitOwner = payloadStringOrNull(event.payload.subagentOwnerToolUseId);
        if (explicitOwner) {
          ownerToolUseId = resolveOwnerToolUseId(event, explicitOwner);
        }

        if (!ownerToolUseId) {
          const launcherToolUseId = payloadStringOrNull(event.payload.launcherToolUseId);
          if (launcherToolUseId) {
            ownerToolUseId = resolveOwnerToolUseId(event, launcherToolUseId);
          }
        }

        if (!ownerToolUseId && requestId) {
          ownerToolUseId = permissionOwnerByRequestId.get(requestId) ?? null;
        }

        if (!ownerToolUseId) {
          const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? requestId ?? event.id;
          ownerToolUseId = resolveOwnerToolUseId(event, toolUseId);
        }

        if (requestId && ownerToolUseId) {
          permissionOwnerByRequestId.set(requestId, ownerToolUseId);
        }
      } else {
        if (requestId) {
          ownerToolUseId = permissionOwnerByRequestId.get(requestId) ?? null;
        }

        if (!ownerToolUseId) {
          const explicitOwner = payloadStringOrNull(event.payload.subagentOwnerToolUseId);
          if (explicitOwner) {
            ownerToolUseId = resolveOwnerToolUseId(event, explicitOwner);
          }
        }

        if (!ownerToolUseId) {
          const launcherToolUseId = payloadStringOrNull(event.payload.launcherToolUseId);
          if (launcherToolUseId) {
            ownerToolUseId = resolveOwnerToolUseId(event, launcherToolUseId);
          }
        }

        if (!ownerToolUseId) {
          const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? requestId ?? event.id;
          ownerToolUseId = resolveOwnerToolUseId(event, toolUseId);
        }
      }

      if (!ownerToolUseId) {
        if (event.type === "permission.requested") {
          const ownershipReason = payloadStringOrNull(event.payload.ownershipReason);
          if (ownershipReason === "unresolved_ambiguous_candidates") {
            markReason(event.id, "unclaimed_ambiguous_parent_candidates");
            overlapCandidateEventIds.add(event.id);
          } else if (ownershipReason === "unresolved_overlap_no_lineage") {
            markReason(event.id, "unclaimed_overlap_no_lineage");
            overlapCandidateEventIds.add(event.id);
          }
        }
        const reasonCode = getSubagentAttributionReason(event.id);
        if (reasonCode) {
          pushRenderDebug({
            source: "subagentUtils",
            event: "unclaimedPermissionEvent",
            details: {
              eventId: event.id,
              idx: event.idx,
              requestId,
              reasonCode,
            },
          });
        }
        continue;
      }

      const subagent = activeSubagents.get(ownerToolUseId) ?? finishedSubagentData.get(ownerToolUseId);
      if (!subagent) {
        continue;
      }

      subagent.eventIds.add(event.id);
      continue;
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

