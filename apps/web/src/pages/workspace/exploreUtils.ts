import type { ChatEvent, ExploreActivityEntry, ReadFileTimelineEntry } from "@codesymphony/shared-types";
import { finishedToolUseIds, isExploreLikeBashEvent, isReadToolEvent, isSearchToolEvent, payloadStringOrNull } from "./eventUtils";
import type { ExploreActivityGroup, ExploreRunKind, ExploreRunState } from "./types";

export function shortenReadTargetForDisplay(target: string): string {
  const cleaned = target.trim().replace(/^["'`]+|["'`]+$/g, "");
  const normalized = cleaned.replace(/\\/g, "/");
  const normalizedWithoutLine = normalized.replace(/:\d+(?::\d+)?$/, "");
  const parts = normalizedWithoutLine.replace(/\/+$/, "").split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return cleaned;
  }

  const basename = parts[parts.length - 1];
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;

  if (parent && parent.startsWith(".")) {
    return `${parent}/${basename}`;
  }

  return basename;
}

export function extractReadTargetFromSummary(summary: string): string | null {
  if (/^completed\s+read$/i.test(summary.trim())) {
    return null;
  }

  const stripped = summary.replace(/^(Read|Opened|Cat)\s+/i, "").trim();
  if (stripped.length === 0) {
    return null;
  }

  const cleaned = stripped.replace(/^["'`]+|["'`]+$/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

export function extractReadFileEntry(event: ChatEvent): ReadFileTimelineEntry | null {
  const summary = payloadStringOrNull(event.payload.summary);
  const toolInput = typeof event.payload.toolInput === "object" && event.payload.toolInput != null && !Array.isArray(event.payload.toolInput)
    ? event.payload.toolInput as Record<string, unknown>
    : null;
  const explicitTarget = payloadStringOrNull(event.payload.file_path)
    ?? payloadStringOrNull(event.payload.filePath)
    ?? (toolInput
      ? payloadStringOrNull(toolInput.file_path)
        ?? payloadStringOrNull(toolInput.filePath)
        ?? payloadStringOrNull(toolInput.path)
        ?? payloadStringOrNull(toolInput.file)
      : null);

  if (summary) {
    const target = extractReadTargetFromSummary(summary) ?? explicitTarget;
    if (target) {
      return {
        label: shortenReadTargetForDisplay(target),
        openPath: target,
      };
    }

    return {
      label: "file",
      openPath: null,
    };
  }

  if (explicitTarget) {
    return {
      label: shortenReadTargetForDisplay(explicitTarget),
      openPath: explicitTarget,
    };
  }

  return null;
}

export function normalizeSearchSummary(summary: string): string {
  const normalized = summary.trim();
  if (normalized.length === 0) {
    return "Searched";
  }

  if (/^searched\s+for\s+/i.test(normalized)) {
    return normalized;
  }

  if (/^completed\s+(glob|grep|search|find|list|scan|ls)\b/i.test(normalized)) {
    return "Searched";
  }

  return `Searched for ${normalized}`;
}

export function searchContextFromEvent(event: ChatEvent): { toolName: string | null; searchParams: string | null } {
  const toolName = payloadStringOrNull(event.payload.toolName);
  const searchParams = payloadStringOrNull(event.payload.searchParams);
  return {
    toolName: toolName ? toolName.trim() : null,
    searchParams: searchParams ? searchParams.trim() : null,
  };
}

/** Shorten absolute path values in searchParams (e.g. path=/a/b/c becomes path=c). */
function shortenSearchParams(params: string): string {
  return params.replace(
    /(\b(?:path|file|file_path|directory|dir)=)(\/[^\s,]+)/g,
    (_match, prefix: string, pathValue: string) => `${prefix}${shortenReadTargetForDisplay(pathValue)}`,
  );
}

export function buildSearchRunningLabel(toolName: string | null, searchParams: string | null): string {
  const base = `Searching ${toolName && toolName.length > 0 ? toolName : "Search"}`;
  if (searchParams && searchParams.length > 0) {
    return `${base} (${shortenSearchParams(searchParams)})`;
  }
  return base;
}

export function buildSearchCompletedFallbackLabel(toolName: string | null, searchParams: string | null): string {
  const base = `Searched${toolName && toolName.length > 0 ? ` ${toolName}` : ""}`;
  if (searchParams && searchParams.length > 0) {
    return `${base} (${shortenSearchParams(searchParams)})`;
  }
  return base;
}

export function extractSearchEntryLabel(
  event: ChatEvent,
  options?: { toolName?: string | null; searchParams?: string | null },
): string {
  const fallbackToolName = options?.toolName ?? null;
  const fallbackSearchParams = options?.searchParams ?? null;
  const summary = payloadStringOrNull(event.payload.summary);
  if (summary) {
    const normalized = summary.trim();
    if (/^completed\s+(glob|grep|search|find|list|scan|ls)\b/i.test(normalized)) {
      return buildSearchCompletedFallbackLabel(fallbackToolName, fallbackSearchParams);
    }
    return normalizeSearchSummary(summary);
  }

  return buildSearchCompletedFallbackLabel(fallbackToolName, fallbackSearchParams);
}

export function extractExploreRunKind(event: ChatEvent): ExploreRunKind | null {
  if (isReadToolEvent(event)) {
    return "read";
  }

  if (isSearchToolEvent(event)) {
    return "search";
  }

  // Explore-like bash commands (ls, find, tree, etc.) are treated as search
  if (isExploreLikeBashEvent(event)) {
    return "search";
  }

  return null;
}

const IDLE_GROUP_BOUNDARY_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "message.delta",
  "thinking.delta",
  "plan.created",
  "plan.approved",
  "plan.revision_requested",
  "subagent.started",
  "subagent.finished",
  "chat.completed",
  "chat.failed",
]);

export function extractExploreActivityGroups(context: ChatEvent[]): ExploreActivityGroup[] {
  const ordered = [...context].sort((a, b) => a.idx - b.idx);
  const groups: ExploreActivityGroup[] = [];
  let currentRuns = new Map<string, ExploreRunState>();
  let currentStartIdx: number | null = null;
  let currentEndIdx: number | null = null;
  let currentCreatedAt: string | null = null;

  function ensureRun(runId: string, kind: ExploreRunKind, event: ChatEvent): ExploreRunState {
    const existing = currentRuns.get(runId);
    if (existing) {
      existing.startIdx = Math.min(existing.startIdx, event.idx);
      existing.eventIds.add(event.id);
      return existing;
    }

    const created: ExploreRunState = {
      id: runId,
      kind,
      pending: true,
      label: kind === "read" ? "file" : "Searching...",
      openPath: null,
      searchToolName: null,
      searchParams: null,
      orderIdx: event.idx,
      startIdx: event.idx,
      createdAt: event.createdAt,
      eventIds: new Set([event.id]),
    };
    currentRuns.set(runId, created);
    return created;
  }

  function markGroupEvent(event: ChatEvent) {
    currentStartIdx = currentStartIdx == null ? event.idx : Math.min(currentStartIdx, event.idx);
    currentEndIdx = currentEndIdx == null ? event.idx : Math.max(currentEndIdx, event.idx);
    if (currentCreatedAt == null) {
      currentCreatedAt = event.createdAt;
    }
  }

  function resetCurrentGroupState() {
    currentRuns = new Map<string, ExploreRunState>();
    currentStartIdx = null;
    currentEndIdx = null;
    currentCreatedAt = null;
  }

  function hasPendingRuns(): boolean {
    for (const run of currentRuns.values()) {
      if (run.pending) {
        return true;
      }
    }
    return false;
  }

  function flushGroupIfIdle() {
    if (!hasPendingRuns()) {
      flushGroup();
    }
  }

  function flushGroup() {
    if (currentRuns.size === 0 || currentStartIdx == null || currentEndIdx == null || currentCreatedAt == null) {
      resetCurrentGroupState();
      return;
    }

    const groupStartIdx = currentStartIdx;
    const groupEndIdx = currentEndIdx;
    const runs = Array.from(currentRuns.values());
    const entries = runs
      .map((run): ExploreActivityEntry => ({
        kind: run.kind,
        label: run.pending
          ? (run.kind === "read"
            ? "Reading..."
            : (run.label.length > 0 ? run.label : "Searching..."))
          : run.label,
        openPath: run.pending ? null : run.openPath,
        pending: run.pending,
        orderIdx: run.orderIdx,
      }))
      .sort((a, b) => {
        if (a.orderIdx !== b.orderIdx) {
          return a.orderIdx - b.orderIdx;
        }

        if (a.pending !== b.pending) {
          return a.pending ? 1 : -1;
        }

        return a.kind.localeCompare(b.kind);
      });
    const fileCount = runs.filter((run) => run.kind === "read").length;
    const searchCount = runs.filter((run) => run.kind === "search").length;
    if (fileCount === 0 && searchCount === 0) {
      resetCurrentGroupState();
      return;
    }

    const eventIds = new Set<string>();
    runs.forEach((run) => {
      run.eventIds.forEach((eventId) => eventIds.add(eventId));
    });
    groups.push({
      id: `explore:${groupStartIdx}:${groupEndIdx}`,
      status: runs.some((run) => run.pending) ? "running" : "success",
      fileCount,
      searchCount,
      entries,
      startIdx: groupStartIdx,
      endIdx: groupEndIdx,
      anchorIdx: groupStartIdx,
      createdAt: currentCreatedAt,
      eventIds,
    });

    resetCurrentGroupState();
  }

  for (const event of ordered) {
    if (IDLE_GROUP_BOUNDARY_EVENT_TYPES.has(event.type)) {
      flushGroupIfIdle();
      continue;
    }

    if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
      continue;
    }

    const kindFromEvent = extractExploreRunKind(event);
    const toolUseId = payloadStringOrNull(event.payload.toolUseId);

    if (event.type === "tool.started" || event.type === "tool.output") {
      const runId = toolUseId ?? `${event.type}:${event.id}`;
      const existing = currentRuns.get(runId);
      const kind = existing?.kind ?? kindFromEvent;
      if (!kind) {
        continue;
      }

      markGroupEvent(event);
      const run = ensureRun(runId, kind, event);
      run.pending = true;
      run.orderIdx = Math.max(run.orderIdx, event.idx);
      if (run.kind === "search") {
        const ctx = searchContextFromEvent(event);
        run.searchToolName = ctx.toolName ?? run.searchToolName;
        run.searchParams = ctx.searchParams ?? run.searchParams;
        run.label = buildSearchRunningLabel(run.searchToolName, run.searchParams);
      }
      continue;
    }

    const runIds = finishedToolUseIds(event);
    for (const runId of runIds) {
      const existing = currentRuns.get(runId);
      const kind = existing?.kind ?? kindFromEvent;
      if (!kind) {
        continue;
      }

      markGroupEvent(event);
      const run = existing ?? ensureRun(runId, kind, event);
      run.pending = false;
      run.orderIdx = event.idx;
      run.eventIds.add(event.id);

      if (run.kind === "read") {
        const readFile = extractReadFileEntry(event);
        run.label = readFile?.label ?? "file";
        run.openPath = readFile?.openPath ?? null;
        continue;
      }

      const ctx = searchContextFromEvent(event);
      run.searchToolName = ctx.toolName ?? run.searchToolName;
      run.searchParams = ctx.searchParams ?? run.searchParams;
      run.label = extractSearchEntryLabel(event, {
        toolName: run.searchToolName,
        searchParams: run.searchParams,
      });
      run.openPath = null;
    }
  }

  flushGroup();
  return groups;
}
