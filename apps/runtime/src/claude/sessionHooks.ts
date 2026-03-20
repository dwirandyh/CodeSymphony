import { readFileSync } from "node:fs";

import type {
  ClaudeOwnershipDiagnostics,
  ClaudeOwnershipReason,
  ClaudeToolInstrumentationDecision,
  ClaudeToolInstrumentationEvent,
} from "../types.js";
import type { ChatThreadPermissionProfile } from "@codesymphony/shared-types";
import { appendRuntimeDebugLog } from "../routes/debug.js";

import { sanitizeForLog } from "./sanitize.js";
import {
  isBashTool,
  isEditTool,
  commandFromToolInput,
  commandFromUnknownToolInput,
  readTargetFromUnknownToolInput,
  searchParamsFromUnknownToolInput,
  editTargetFromUnknownToolInput,
  type ToolMetadata,
} from "./toolClassification.js";
import { completionSummaryFromMetadata, failureSummaryFromMetadata } from "./toolSummary.js";
import { extractBashToolResult } from "./bashResult.js";
import { parseSubagentTranscript, extractSubagentResponse } from "./subagentTranscript.js";
import { findLatestPlanFile } from "./planFile.js";

import type { InstrumentContext, SessionMaps } from "./sessionInstrumentation.js";
import { buildMetadataFromHookInput, buildFinishedTimingPreview, buildToolFinishedPayload } from "./sessionInstrumentation.js";

function logSubagentDebug(message: string, data: Record<string, unknown>): void {
  appendRuntimeDebugLog({
    source: "sessionHooks",
    message,
    data,
  });
}

function isSubagentLauncherToolName(toolName: string | undefined | null): boolean {
  const normalized = (toolName ?? "").trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}

type SubagentOwnerResolution = ClaudeOwnershipDiagnostics;

type SubagentIdentity = {
  subagentToolUseId: string | null;
  taskToolUseId: string | null;
};

type SubagentOwnerResolveOptions = {
  allowSingleActiveFallback?: boolean;
};

function ownershipReasonFromSource(source: string): ClaudeOwnershipReason {
  if (source === "toolUseId") {
    return "resolved_tool_use_id";
  }
  if (source === "parentToolUseId") {
    return "resolved_parent_tool_use_id";
  }
  if (source === "agentId") {
    return "resolved_agent_id";
  }
  if (source === "singleActiveFallback") {
    return "resolved_single_active_fallback";
  }
  if (source === "subagentPathHint") {
    return "resolved_subagent_path_hint";
  }
  return "unresolved_no_lineage";
}

function withoutDuplicateStrings(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    set.add(value);
  }
  return [...set];
}

export function isReadOrSearchToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "read") {
    return true;
  }

  return /^(glob|grep|search|find|list|scan|ls)$/.test(normalized);
}

function extractSubagentPathHintSourceFromInput(input: Record<string, unknown> | undefined): string {
  if (!input) {
    return "";
  }

  return String(
    input.description
    ?? input.prompt
    ?? input.task
    ?? input.Task
    ?? "",
  );
}

function normalizeOwnershipHintText(value: string): string {
  return value.trim().replace(/[\\]+/g, "/").toLowerCase();
}

function extractDerivedSkillPathHints(source: string): string[] {
  const hints = new Set<string>();
  const normalizedSource = normalizeOwnershipHintText(source);
  const skillSlugPattern = /\b([a-z0-9][a-z0-9-]{1,})\s+skill\b/g;

  for (const match of normalizedSource.matchAll(skillSlugPattern)) {
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
}

function extractOwnershipPathHints(source: string): string[] {
  const normalizedSource = source.trim();
  if (normalizedSource.length === 0) {
    return [];
  }

  const hints = new Set<string>();
  for (const rawToken of normalizedSource.split(/\s+/)) {
    const token = rawToken
      .replace(/^[\("'`]+/, "")
      .replace(/[\)\]"'`.,:;!?]+$/g, "")
      .trim();
    if (token.length < 2 || token === "." || token === "..") {
      continue;
    }

    if (!token.includes("/") && !token.startsWith(".")) {
      continue;
    }

    hints.add(normalizeOwnershipHintText(token));
  }

  for (const derivedHint of extractDerivedSkillPathHints(normalizedSource)) {
    hints.add(derivedHint);
  }

  return [...hints];
}

function isPathHintEligibleToolName(toolName: string): boolean {
  if (isReadOrSearchToolName(toolName)) {
    return true;
  }

  return isBashTool(toolName);
}

function resolveOwnerCandidatesFromPathHint(
  maps: SessionMaps,
  toolUseId: string | null,
): string[] {
  if (!toolUseId) {
    return [];
  }

  const metadata = maps.toolMetadataByUseId.get(toolUseId);
  const requestedToolName = maps.requestedToolByUseId.get(toolUseId)?.toolName;
  const toolName = metadata?.toolName ?? requestedToolName ?? "";
  if (!toolName || !isPathHintEligibleToolName(toolName)) {
    return [];
  }

  const hintTarget = normalizeOwnershipHintText(
    [metadata?.command, metadata?.readTarget, metadata?.searchParams]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" "),
  );
  if (hintTarget.length === 0) {
    return [];
  }

  const candidates: string[] = [];
  for (const subagentToolUseId of maps.activeSubagentToolUseIds) {
    const subagentInput = maps.subagentToolInputByUseId.get(subagentToolUseId);
    const description = extractSubagentPathHintSourceFromInput(subagentInput);
    const hints = extractOwnershipPathHints(description);
    if (hints.length === 0) {
      continue;
    }

    if (hints.some((hint) => hintTarget.includes(hint))) {
      candidates.push(subagentToolUseId);
    }
  }

  return withoutDuplicateStrings(candidates);
}

function maybeLogOwnershipDiagnostics(
  maps: SessionMaps,
  params: { toolUseId?: string | null; parentToolUseId?: string | null; agentId?: string | null },
  resolution: SubagentOwnerResolution,
): void {
  const normalizedToolUseId = normalizeToolUseId(params.toolUseId);
  const normalizedParentToolUseId = normalizeToolUseId(params.parentToolUseId);
  const normalizedAgentId = normalizeToolUseId(params.agentId);
  const requested = normalizedToolUseId ? maps.requestedToolByUseId.get(normalizedToolUseId) : undefined;
  const requestedToolName = requested?.toolName ?? maps.toolMetadataByUseId.get(normalizedToolUseId ?? "")?.toolName;
  const targetToolName = typeof requestedToolName === "string" ? requestedToolName : "";

  const cacheKey = JSON.stringify({
    reason: resolution.ownershipReason,
    toolUseId: normalizedToolUseId,
    parentToolUseId: normalizedParentToolUseId,
    agentId: normalizedAgentId,
    toolName: targetToolName,
    candidates: resolution.ownershipCandidates ?? [],
  });
  if (maps.ownershipDebugLogCache.has(cacheKey)) {
    return;
  }
  maps.ownershipDebugLogCache.add(cacheKey);

  if (resolution.ownershipReason === "unresolved_ambiguous_candidates") {
    logSubagentDebug("subagent.ownerResolution.ambiguousRuntime", {
      toolUseId: normalizedToolUseId,
      parentToolUseId: normalizedParentToolUseId,
      agentId: normalizedAgentId,
      toolName: targetToolName || null,
      ownershipCandidates: resolution.ownershipCandidates ?? [],
      activeSubagentToolUseIds: resolution.activeSubagentToolUseIds ?? [],
    });
    return;
  }

  if (
    (resolution.ownershipReason === "unresolved_no_lineage"
      || resolution.ownershipReason === "unresolved_overlap_no_lineage")
    && targetToolName
    && isReadOrSearchToolName(targetToolName)
  ) {
    const subagentHintDiagnostics = (resolution.activeSubagentToolUseIds ?? []).map((subagentToolUseId) => {
      const subagentInput = maps.subagentToolInputByUseId.get(subagentToolUseId);
      const description = extractSubagentPathHintSourceFromInput(subagentInput);
      return {
        subagentToolUseId,
        launcherToolUseId: resolveLauncherForSubagentOwner(maps, subagentToolUseId),
        description,
        extractedHints: extractOwnershipPathHints(description),
      };
    });
    logSubagentDebug("subagent.ownerResolution.unresolvedReadSearch", {
      toolUseId: normalizedToolUseId,
      parentToolUseId: normalizedParentToolUseId,
      agentId: normalizedAgentId,
      toolName: targetToolName,
      ownershipCandidates: resolution.ownershipCandidates ?? [],
      ownershipReason: resolution.ownershipReason,
      activeSubagentToolUseIds: resolution.activeSubagentToolUseIds ?? [],
      activeLauncherToolUseIds: (resolution.activeSubagentToolUseIds ?? [])
        .map((subagentToolUseId) => resolveLauncherForSubagentOwner(maps, subagentToolUseId))
        .filter((launcherToolUseId): launcherToolUseId is string => typeof launcherToolUseId === "string" && launcherToolUseId.length > 0),
      pathHintCandidates: normalizedToolUseId
        ? resolveOwnerCandidatesFromPathHint(maps, normalizedToolUseId)
        : [],
      subagentHintDiagnostics,
    });
  }
}

function maybeLogOwnershipTransition(
  maps: SessionMaps,
  toolUseId: string | null | undefined,
  resolution: SubagentOwnerResolution,
  context: string,
): void {
  const normalizedToolUseId = normalizeToolUseId(toolUseId);
  if (!normalizedToolUseId || !resolution.subagentOwnerToolUseId) {
    return;
  }

  const previous = maps.requestedToolByUseId.get(normalizedToolUseId)?.parentToolUseId
    ?? maps.subagentOwnerToolUseIdByToolUseId.get(normalizedToolUseId)
    ?? null;
  if (previous === resolution.subagentOwnerToolUseId) {
    return;
  }

  const cacheKey = `transition:${context}:${normalizedToolUseId}:${previous ?? "null"}:${resolution.subagentOwnerToolUseId}`;
  if (maps.ownershipDebugLogCache.has(cacheKey)) {
    return;
  }
  maps.ownershipDebugLogCache.add(cacheKey);

  logSubagentDebug("subagent.ownerResolution.transition", {
    context,
    toolUseId: normalizedToolUseId,
    previousSubagentOwnerToolUseId: previous,
    nextSubagentOwnerToolUseId: resolution.subagentOwnerToolUseId,
    launcherToolUseId: resolution.launcherToolUseId,
    ownershipReason: resolution.ownershipReason,
    ownershipCandidates: resolution.ownershipCandidates ?? [],
  });
}

function normalizeToolUseId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSubagentOwnerFromCandidate(
  maps: SessionMaps,
  candidate: string | null,
): string | null {
  if (!candidate) {
    return null;
  }

  const knownOwner = maps.subagentOwnerToolUseIdByToolUseId.get(candidate);
  if (knownOwner) {
    return knownOwner;
  }

  const mappedFromTask = maps.subagentToolUseIdByTaskToolUseId.get(candidate);
  if (mappedFromTask) {
    return mappedFromTask;
  }

  if (maps.subagentTaskToolUseIdBySubagentToolUseId.has(candidate)) {
    return candidate;
  }

  if (maps.activeSubagentToolUseIds.includes(candidate)) {
    return candidate;
  }

  return null;
}

function resolveLauncherForSubagentOwner(
  maps: SessionMaps,
  subagentOwnerToolUseId: string,
): string | null {
  const activeLauncher = maps.subagentTaskToolUseIdBySubagentToolUseId.get(subagentOwnerToolUseId);
  if (activeLauncher) {
    return activeLauncher;
  }

  for (const [taskToolUseId, mappedSubagentToolUseId] of maps.subagentToolUseIdByTaskToolUseId.entries()) {
    if (mappedSubagentToolUseId === subagentOwnerToolUseId && taskToolUseId !== subagentOwnerToolUseId) {
      return taskToolUseId;
    }
  }

  return null;
}

export function resolveCanonicalSubagentOwner(
  maps: SessionMaps,
  params: {
    toolUseId?: string | null;
    parentToolUseId?: string | null;
    agentId?: string | null;
  },
  options: SubagentOwnerResolveOptions = {},
): SubagentOwnerResolution {
  const rawToolUseId = normalizeToolUseId(params.toolUseId);
  const rawParentToolUseId = normalizeToolUseId(params.parentToolUseId);
  const rawAgentId = normalizeToolUseId(params.agentId);

  const candidates: Array<{ owner: string; launcher: string | null; source: string }> = [];

  const addOwnerCandidate = (owner: string | null, source: string): void => {
    if (!owner) {
      return;
    }

    candidates.push({
      owner,
      launcher: resolveLauncherForSubagentOwner(maps, owner),
      source,
    });
  };

  addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, rawToolUseId), "toolUseId");
  addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, rawParentToolUseId), "parentToolUseId");

  if (rawAgentId) {
    const mappedSubagentToolUseId = maps.agentIdToToolUseId.get(rawAgentId) ?? null;
    addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, mappedSubagentToolUseId), "agentId");
  }

  const allowSingleActiveFallback = options.allowSingleActiveFallback ?? true;
  if (allowSingleActiveFallback && candidates.length === 0 && maps.activeSubagentToolUseIds.length === 1) {
    const onlyActiveOwner = maps.activeSubagentToolUseIds[0] ?? null;
    addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, onlyActiveOwner), "singleActiveFallback");
  }

  if (candidates.length === 0 && maps.activeSubagentToolUseIds.length > 1) {
    const hintedOwners = resolveOwnerCandidatesFromPathHint(maps, rawToolUseId);
    for (const hintedOwner of hintedOwners) {
      addOwnerCandidate(resolveSubagentOwnerFromCandidate(maps, hintedOwner), "subagentPathHint");
    }
  }

  const ownershipCandidates = withoutDuplicateStrings(candidates.map((candidate) => candidate.owner));

  if (candidates.length === 0) {
    const unresolvedNoLineage: SubagentOwnerResolution = {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
      ownershipReason: maps.activeSubagentToolUseIds.length > 1
        ? "unresolved_overlap_no_lineage"
        : "unresolved_no_lineage",
      ...(maps.activeSubagentToolUseIds.length > 1
        ? { activeSubagentToolUseIds: [...maps.activeSubagentToolUseIds] }
        : {}),
    };
    maybeLogOwnershipDiagnostics(maps, params, unresolvedNoLineage);
    return unresolvedNoLineage;
  }

  const uniqueOwners = new Set(candidates.map((candidate) => candidate.owner));
  if (uniqueOwners.size > 1) {
    const ambiguousResolution: SubagentOwnerResolution = {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
      ownershipReason: "unresolved_ambiguous_candidates",
      ownershipCandidates,
      activeSubagentToolUseIds: [...maps.activeSubagentToolUseIds],
    };
    logSubagentDebug("subagent.ownerResolution.ambiguous", {
      toolUseId: rawToolUseId,
      parentToolUseId: rawParentToolUseId,
      agentId: rawAgentId,
      candidates,
      activeSubagentToolUseIds: [...maps.activeSubagentToolUseIds],
      activeLauncherToolUseIds: maps.activeSubagentToolUseIds
        .map((subagentToolUseId) => resolveLauncherForSubagentOwner(maps, subagentToolUseId))
        .filter((launcherToolUseId): launcherToolUseId is string => typeof launcherToolUseId === "string" && launcherToolUseId.length > 0),
      ownershipReason: ambiguousResolution.ownershipReason,
      ownershipCandidates: ambiguousResolution.ownershipCandidates,
    });
    maybeLogOwnershipDiagnostics(maps, params, ambiguousResolution);
    return ambiguousResolution;
  }

  const resolved = candidates[0];
  if (!resolved) {
    const unresolvedNoLineage: SubagentOwnerResolution = {
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
      ownershipReason: "unresolved_no_lineage",
    };
    maybeLogOwnershipDiagnostics(maps, params, unresolvedNoLineage);
    return unresolvedNoLineage;
  }

  const resolvedOwner: SubagentOwnerResolution = {
    subagentOwnerToolUseId: resolved.owner,
    launcherToolUseId: resolved.launcher,
    ownershipReason: ownershipReasonFromSource(resolved.source),
    ...(ownershipCandidates.length > 1 ? { ownershipCandidates } : {}),
  };
  maybeLogOwnershipDiagnostics(maps, params, resolvedOwner);
  return resolvedOwner;
}

export function resolveSubagentIdentity(
  maps: SessionMaps,
  params: {
    toolUseId?: string | null;
    parentToolUseId?: string | null;
    agentId?: string | null;
  },
  options: SubagentOwnerResolveOptions = {},
): SubagentIdentity {
  const owner = resolveCanonicalSubagentOwner(maps, params, options);
  if (!owner.subagentOwnerToolUseId) {
    return {
      subagentToolUseId: null,
      taskToolUseId: null,
    };
  }

  return {
    subagentToolUseId: owner.subagentOwnerToolUseId,
    taskToolUseId: owner.launcherToolUseId
      ?? resolveLauncherForSubagentOwner(maps, owner.subagentOwnerToolUseId),
  };
}

export function rememberSubagentOwner(
  maps: SessionMaps,
  toolUseId: string | null | undefined,
  ownerToolUseId: string,
): void {
  const normalizedToolUseId = normalizeToolUseId(toolUseId);
  const normalizedOwnerToolUseId = normalizeToolUseId(ownerToolUseId);
  if (!normalizedToolUseId || !normalizedOwnerToolUseId) {
    return;
  }

  const existingOwner = maps.subagentOwnerToolUseIdByToolUseId.get(normalizedToolUseId);
  if (existingOwner && existingOwner !== normalizedOwnerToolUseId) {
    logSubagentDebug("subagent.ownerMapping.conflict", {
      toolUseId: normalizedToolUseId,
      existingOwner,
      nextOwner: normalizedOwnerToolUseId,
    });
    return;
  }

  maps.subagentOwnerToolUseIdByToolUseId.set(normalizedToolUseId, normalizedOwnerToolUseId);
}

function rememberSubagentTaskBridge(
  maps: SessionMaps,
  taskToolUseId: string | null | undefined,
  subagentToolUseId: string | null | undefined,
): void {
  const normalizedTaskToolUseId = normalizeToolUseId(taskToolUseId);
  const normalizedSubagentToolUseId = normalizeToolUseId(subagentToolUseId);
  if (!normalizedTaskToolUseId || !normalizedSubagentToolUseId) {
    return;
  }

  const existingSubagentToolUseId = maps.subagentToolUseIdByTaskToolUseId.get(normalizedTaskToolUseId);
  if (existingSubagentToolUseId && existingSubagentToolUseId !== normalizedSubagentToolUseId) {
    logSubagentDebug("subagent.taskBridge.conflict", {
      taskToolUseId: normalizedTaskToolUseId,
      existingSubagentToolUseId,
      nextSubagentToolUseId: normalizedSubagentToolUseId,
    });
    return;
  }

  maps.subagentToolUseIdByTaskToolUseId.set(normalizedTaskToolUseId, normalizedSubagentToolUseId);
  rememberSubagentOwner(maps, normalizedTaskToolUseId, normalizedSubagentToolUseId);
  rememberSubagentOwner(maps, normalizedSubagentToolUseId, normalizedSubagentToolUseId);
}

export type HookCallbacks = {
  onToolStarted: (payload: {
    toolName: string;
    toolUseId: string;
    parentToolUseId: string | null;
    subagentOwnerToolUseId?: string | null;
    launcherToolUseId?: string | null;
    ownershipReason?: ClaudeOwnershipReason;
    ownershipCandidates?: string[];
    activeSubagentToolUseIds?: string[];
    command?: string;
    searchParams?: string;
    editTarget?: string;
    shell?: "bash";
    isBash?: true;
  }) => Promise<void> | void;
  onToolFinished: (payload: {
    summary: string;
    precedingToolUseIds: string[];
    subagentResponse?: string;
    subagentOwnerToolUseId?: string | null;
    launcherToolUseId?: string | null;
    ownershipReason?: ClaudeOwnershipReason;
    ownershipCandidates?: string[];
    activeSubagentToolUseIds?: string[];
    command?: string;
    searchParams?: string;
    editTarget?: string;
    toolInput?: Record<string, unknown>;
    output?: string;
    error?: string;
    shell?: "bash";
    isBash?: true;
    truncated?: boolean;
    outputBytes?: number;
  }) => Promise<void> | void;
  onQuestionRequest: (payload: {
    requestId: string;
    questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  }) => Promise<{ answers: Record<string, string> }>;
  onPermissionRequest: (payload: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    blockedPath: string | null;
    decisionReason: string | null;
    suggestions: unknown[] | null;
    subagentOwnerToolUseId: string | null;
    launcherToolUseId: string | null;
    ownershipReason?: ClaudeOwnershipReason;
    ownershipCandidates?: string[];
    activeSubagentToolUseIds?: string[];
  }) => Promise<{ decision: string; message?: string }> | { decision: string; message?: string };
  onPlanFileDetected: (payload: {
    filePath: string;
    content: string;
    source?: "claude_plan_file" | "streaming_fallback";
  }) => Promise<void> | void;
  onSubagentStarted: (payload: {
    agentId: string;
    agentType: string;
    toolUseId: string;
    description: string;
  }) => Promise<void> | void;
  onSubagentStopped: (payload: {
    agentId: string;
    agentType: string;
    toolUseId: string;
    description: string;
    lastMessage: string;
    isResponseUpdate?: boolean;
  }) => Promise<void> | void;
};

export type SessionState = {
  finalOutput: string;
  planFileDetected: boolean;
  queryStartTimestamp: number;
};

const REVIEW_GIT_COMMAND_PATTERN = /^(git|gh|glab)(\s|$)/;
const REVIEW_GIT_HEREDOC_SUBSTITUTION_PATTERN = /\$\(\s*cat\s+<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))\r?\n[\s\S]*?\r?\n(?:\2|\3)\s*\)/g;
const REVIEW_GIT_HEREDOC_PLACEHOLDER = "__REVIEW_GIT_HEREDOC__";

function isReviewGitCommand(command: string | null | undefined): boolean {
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

export function createCanUseTool(
  callbacks: HookCallbacks,
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  emitDecision: (
    toolUseId: string,
    decision: ClaudeToolInstrumentationDecision,
    toolName: string,
    parentToolUseId: string | null,
    preview: ClaudeToolInstrumentationEvent["preview"],
  ) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
  state: SessionState,
  permissionMode: string | undefined,
  autoAcceptTools: boolean | undefined,
  permissionProfile: ChatThreadPermissionProfile | undefined,
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      toolUseID: string;
      agentID?: string;
      blockedPath?: string;
      decisionReason?: string;
      suggestions?: unknown[];
    },
  ) => {
    const toolUseId = options.toolUseID;
    const command = commandFromToolInput(input);
    const isBash = isBashTool(toolName);
    const nowMs = Date.now();

    maps.toolMetadataByUseId.set(toolUseId, {
      toolName,
      command,
      readTarget: readTargetFromUnknownToolInput(toolName, input),
      searchParams: searchParamsFromUnknownToolInput(toolName, input),
      editTarget: editTargetFromUnknownToolInput(toolName, input),
      isBash,
    });
    maps.subagentToolInputByUseId.set(toolUseId, input);
    if (isSubagentLauncherToolName(toolName) && !maps.pendingSubagentTaskToolUseIds.includes(toolUseId)) {
      maps.pendingSubagentTaskToolUseIds.push(toolUseId);
    }

    const canonicalRequestOwner = resolveCanonicalSubagentOwner(
      maps,
      {
        toolUseId,
        parentToolUseId: null,
        agentId: options.agentID ?? null,
      },
      { allowSingleActiveFallback: false },
    );
    if (canonicalRequestOwner.subagentOwnerToolUseId) {
      maybeLogOwnershipTransition(maps, toolUseId, canonicalRequestOwner, "canUseTool.requested");
      rememberSubagentOwner(maps, toolUseId, canonicalRequestOwner.subagentOwnerToolUseId);
      if (canonicalRequestOwner.launcherToolUseId) {
        rememberSubagentTaskBridge(
          maps,
          canonicalRequestOwner.launcherToolUseId,
          canonicalRequestOwner.subagentOwnerToolUseId,
        );
      }
    }

    const permissionParentToolUseId = canonicalRequestOwner.subagentOwnerToolUseId ?? null;
    maps.requestedToolByUseId.set(toolUseId, {
      toolName,
      parentToolUseId: permissionParentToolUseId,
      requestedAtMs: nowMs,
    });
    await emitInstrumentation({
      stage: "requested",
      toolUseId,
      toolName,
      parentToolUseId: permissionParentToolUseId,
      threadContext: instrumentContext,
      timing: {
        startedAt: new Date(nowMs).toISOString(),
      },
      preview: {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      },
    });

    if (permissionMode === "plan" && toolName !== "AskUserQuestion") {
      if (!state.planFileDetected && state.finalOutput.trim().length > 0) {
        state.planFileDetected = true;
        let detectedPlan: { filePath: string; content: string; source: "claude_plan_file" | "streaming_fallback" } | null = null;
        for (const fp of maps.sessionPersistedPlanFiles) {
          try {
            const content = readFileSync(fp, "utf-8");
            if (content.trim().length > 0) {
              detectedPlan = { filePath: fp, content, source: "claude_plan_file" };
            }
          } catch { /* skip unreadable */ }
        }
        if (!detectedPlan) {
          const planFile = findLatestPlanFile(state.queryStartTimestamp);
          if (planFile) {
            detectedPlan = { ...planFile, source: "claude_plan_file" };
          }
        }
        await callbacks.onPlanFileDetected(detectedPlan ?? {
          filePath: "streaming-plan",
          content: state.finalOutput.trim(),
          source: "streaming_fallback",
        });
      }
      await emitDecision(toolUseId, "plan_deny", toolName, permissionParentToolUseId, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        decisionReason: "Plan requires user approval before execution.",
      });
      return {
        behavior: "deny" as const,
        message: "Plan requires user approval before execution.",
      };
    }

    if (toolName === "AskUserQuestion") {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const result = await callbacks.onQuestionRequest({
        requestId: toolUseId,
        questions,
      });
      await emitDecision(toolUseId, "allow", toolName, permissionParentToolUseId, {
        input: sanitizeForLog(input),
      });
      return {
        behavior: "allow" as const,
        updatedInput: { ...input, answers: result.answers },
      };
    }

    const requiresUserApproval = Boolean(
      options.blockedPath || options.decisionReason || (options.suggestions?.length ?? 0) > 0,
    );

    if (requiresUserApproval && isEditTool(toolName)) {
      await emitDecision(toolUseId, "auto_allow", toolName, permissionParentToolUseId, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    if (!requiresUserApproval) {
      await emitDecision(toolUseId, "allow", toolName, permissionParentToolUseId, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    if (permissionProfile === "review_git" && isBash && isReviewGitCommand(command)) {
      await emitDecision(toolUseId, "auto_allow", toolName, permissionParentToolUseId, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    if (autoAcceptTools) {
      await emitDecision(toolUseId, "auto_allow", toolName, permissionParentToolUseId, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    const permissionOwner = resolveCanonicalSubagentOwner(
      maps,
      {
        toolUseId,
        parentToolUseId: permissionParentToolUseId,
        agentId: options.agentID ?? null,
      },
      { allowSingleActiveFallback: false },
    );
    const resolvedPermissionParentToolUseId = permissionOwner.subagentOwnerToolUseId ?? permissionParentToolUseId;
    if (permissionOwner.subagentOwnerToolUseId) {
      maybeLogOwnershipTransition(maps, toolUseId, permissionOwner, "canUseTool.permissionRequest");
      rememberSubagentOwner(maps, toolUseId, permissionOwner.subagentOwnerToolUseId);
      if (permissionOwner.launcherToolUseId) {
        rememberSubagentTaskBridge(
          maps,
          permissionOwner.launcherToolUseId,
          permissionOwner.subagentOwnerToolUseId,
        );
      }
    }

    const decision = await callbacks.onPermissionRequest({
      requestId: toolUseId,
      toolName,
      toolInput: input,
      blockedPath: options.blockedPath ?? null,
      decisionReason: options.decisionReason ?? null,
      suggestions: options.suggestions ?? null,
      subagentOwnerToolUseId: permissionOwner.subagentOwnerToolUseId,
      launcherToolUseId: permissionOwner.launcherToolUseId,
      ownershipReason: permissionOwner.ownershipReason,
      ...(permissionOwner.ownershipCandidates && permissionOwner.ownershipCandidates.length > 0
        ? { ownershipCandidates: permissionOwner.ownershipCandidates }
        : {}),
      ...(permissionOwner.activeSubagentToolUseIds && permissionOwner.activeSubagentToolUseIds.length > 0
        ? { activeSubagentToolUseIds: permissionOwner.activeSubagentToolUseIds }
        : {}),
    });

    if (decision.decision === "allow") {
      await emitDecision(toolUseId, "allow", toolName, resolvedPermissionParentToolUseId, {
        ...(command ? { command } : {}),
        input: sanitizeForLog(input),
        blockedPath: options.blockedPath ?? null,
        decisionReason: options.decisionReason ?? null,
        suggestionsCount: options.suggestions?.length ?? 0,
      });
      return {
        behavior: "allow" as const,
        updatedInput: input,
      };
    }

    await emitDecision(toolUseId, "deny", toolName, resolvedPermissionParentToolUseId, {
      ...(command ? { command } : {}),
      input: sanitizeForLog(input),
      blockedPath: options.blockedPath ?? null,
      decisionReason: options.decisionReason ?? null,
      suggestionsCount: options.suggestions?.length ?? 0,
    });

    return {
      behavior: "deny" as const,
      message: decision.message ?? "Tool execution denied by user.",
    };
  };
}

export function createPreToolUseHook(
  markStarted: (
    toolUseId: string,
    toolName: string,
    parentToolUseId: string | null,
    ownership: ClaudeOwnershipDiagnostics,
    startSource: "sdk.hook.pre_tool_use" | "sdk.stream.tool_progress",
    metadata?: ToolMetadata,
  ) => Promise<void>,
  maps: SessionMaps,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }

    const hookToolUseId = (hookInput.tool_use_id as string) || toolUseID;
    if (!hookToolUseId) {
      return { continue: true };
    }

    const command = commandFromUnknownToolInput(hookInput.tool_input);
    const hookToolName = hookInput.tool_name as string;
    maps.toolMetadataByUseId.set(hookToolUseId, {
      toolName: hookToolName,
      command,
      readTarget: readTargetFromUnknownToolInput(hookToolName, hookInput.tool_input),
      searchParams: searchParamsFromUnknownToolInput(hookToolName, hookInput.tool_input),
      isBash: isBashTool(hookToolName),
    });

    const ownership = resolveCanonicalSubagentOwner(
      maps,
      {
        toolUseId: hookToolUseId,
        parentToolUseId: null,
        agentId: null,
      },
      { allowSingleActiveFallback: false },
    );
    const inferredParentToolUseId = ownership.subagentOwnerToolUseId ?? null;
    if (ownership.subagentOwnerToolUseId) {
      maybeLogOwnershipTransition(maps, hookToolUseId, ownership, "preToolUse");
      rememberSubagentOwner(maps, hookToolUseId, ownership.subagentOwnerToolUseId);
    }
    maps.requestedToolByUseId.set(hookToolUseId, {
      toolName: hookToolName,
      parentToolUseId: inferredParentToolUseId,
      requestedAtMs: Date.now(),
    });

    if (isSubagentLauncherToolName(hookToolName)) {
      const hookToolInput = hookInput.tool_input as Record<string, unknown>;
      if (hookToolInput && !maps.subagentToolInputByUseId.has(hookToolUseId)) {
        maps.subagentToolInputByUseId.set(hookToolUseId, hookToolInput);
      }
      if (!maps.pendingSubagentTaskToolUseIds.includes(hookToolUseId)) {
        maps.pendingSubagentTaskToolUseIds.push(hookToolUseId);
      }
    }

    await markStarted(
      hookToolUseId,
      hookToolName,
      inferredParentToolUseId,
      ownership,
      "sdk.hook.pre_tool_use",
      maps.toolMetadataByUseId.get(hookToolUseId),
    );

    return { continue: true };
  };
}

export function createPostToolUseHook(
  callbacks: HookCallbacks,
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "PostToolUse") {
      return { continue: true };
    }

    const hookToolUseId = (hookInput.tool_use_id as string) || toolUseID;
    if (!hookToolUseId) {
      return { continue: true };
    }

    const metadata = buildMetadataFromHookInput(hookInput, hookToolUseId, maps.toolMetadataByUseId);
    const bashResult = extractBashToolResult(hookInput.tool_response);
    if (metadata.isBash && bashResult) {
      maps.bashResultByToolUseId.set(hookToolUseId, bashResult);
    }

    if (isSubagentLauncherToolName(hookInput.tool_name as string)) {
      const responseText = extractSubagentResponse(hookInput.tool_response);
      if (responseText) {
        maps.subagentResponseByUseId.set(hookToolUseId, responseText);
      }
    }

    const owner = resolveCanonicalSubagentOwner(
      maps,
      {
        toolUseId: hookToolUseId,
        parentToolUseId: null,
        agentId: null,
      },
      { allowSingleActiveFallback: false },
    );
    const ownerParentToolUseId = owner.subagentOwnerToolUseId ?? null;
    if (owner.subagentOwnerToolUseId) {
      maybeLogOwnershipTransition(maps, hookToolUseId, owner, "postToolUse");
      rememberSubagentOwner(maps, hookToolUseId, owner.subagentOwnerToolUseId);
      if (owner.launcherToolUseId) {
        rememberSubagentTaskBridge(maps, owner.launcherToolUseId, owner.subagentOwnerToolUseId);
      }
    }

    if (!maps.finishedToolUseIds.has(hookToolUseId)) {
      const finishedAtMs = Date.now();
      const completionSummary = completionSummaryFromMetadata(metadata, hookInput.tool_input);
      await callbacks.onToolFinished({
        ...buildToolFinishedPayload(
          metadata,
          completionSummary,
          [hookToolUseId],
          bashResult ?? undefined,
          maps.subagentResponseByUseId.get(hookToolUseId),
        ),
        subagentOwnerToolUseId: owner.subagentOwnerToolUseId,
        launcherToolUseId: owner.launcherToolUseId,
        ownershipReason: owner.ownershipReason,
        ...(owner.ownershipCandidates && owner.ownershipCandidates.length > 0
          ? { ownershipCandidates: owner.ownershipCandidates }
          : {}),
        ...(owner.activeSubagentToolUseIds && owner.activeSubagentToolUseIds.length > 0
          ? { activeSubagentToolUseIds: owner.activeSubagentToolUseIds }
          : {}),
        ...(metadata.editTarget ? { toolInput: hookInput.tool_input as Record<string, unknown> } : {}),
      });
      const { timing, preview } = buildFinishedTimingPreview(
        hookToolUseId, metadata, finishedAtMs, maps, bashResult ?? undefined, hookInput.tool_response,
      );
      await emitInstrumentation({
        stage: "finished",
        toolUseId: hookToolUseId,
        toolName: metadata.toolName,
        parentToolUseId: ownerParentToolUseId,
        summary: completionSummary,
        threadContext: instrumentContext,
        timing,
        preview,
      });
      maps.finishedToolUseIds.add(hookToolUseId);
    }

    const capturedResponse = maps.subagentResponseByUseId.get(hookToolUseId);
    if (capturedResponse) {
      const subagentIdentity = resolveSubagentIdentity(
        maps,
        {
          toolUseId: hookToolUseId,
          parentToolUseId: null,
          agentId: null,
        },
        { allowSingleActiveFallback: false },
      );
      const responseOwnerToolUseId = subagentIdentity.subagentToolUseId;
      if (responseOwnerToolUseId) {
        maybeLogOwnershipTransition(
          maps,
          hookToolUseId,
          {
            subagentOwnerToolUseId: responseOwnerToolUseId,
            launcherToolUseId: resolveLauncherForSubagentOwner(maps, responseOwnerToolUseId),
            ownershipReason: "resolved_tool_use_id",
          },
          "postToolUse.lateResponseUpdate",
        );
        rememberSubagentOwner(maps, hookToolUseId, responseOwnerToolUseId);
        logSubagentDebug("subagent.postToolUse.lateResponseUpdate", {
          toolUseId: hookToolUseId,
          responseOwnerToolUseId,
          responseLength: capturedResponse.length,
          emitted: true,
        });
        await callbacks.onSubagentStopped({
          agentId: "",
          agentType: "",
          toolUseId: responseOwnerToolUseId,
          description: "",
          lastMessage: capturedResponse,
          isResponseUpdate: true,
        });
      } else {
        logSubagentDebug("subagent.postToolUse.lateResponseUpdate", {
          toolUseId: hookToolUseId,
          responseOwnerToolUseId: null,
          responseLength: capturedResponse.length,
          emitted: false,
          reason: "owner_unresolved",
        });
      }
      maps.subagentResponseByUseId.delete(hookToolUseId);
    }

    return { continue: true };
  };
}

export function createPostToolUseFailureHook(
  callbacks: HookCallbacks,
  emitInstrumentation: (event: ClaudeToolInstrumentationEvent) => Promise<void>,
  maps: SessionMaps,
  instrumentContext: InstrumentContext,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "PostToolUseFailure") {
      return { continue: true };
    }

    const hookToolUseId = (hookInput.tool_use_id as string) || toolUseID;
    if (!hookToolUseId) {
      return { continue: true };
    }

    const metadata = buildMetadataFromHookInput(hookInput, hookToolUseId, maps.toolMetadataByUseId);
    const command = metadata?.command ?? commandFromUnknownToolInput(hookInput.tool_input);
    if (maps.finishedToolUseIds.has(hookToolUseId)) {
      return { continue: true };
    }

    const owner = resolveCanonicalSubagentOwner(
      maps,
      {
        toolUseId: hookToolUseId,
        parentToolUseId: null,
        agentId: null,
      },
      { allowSingleActiveFallback: false },
    );
    const ownerParentToolUseId = owner.subagentOwnerToolUseId ?? null;
    if (owner.subagentOwnerToolUseId) {
      maybeLogOwnershipTransition(maps, hookToolUseId, owner, "postToolUseFailure");
      rememberSubagentOwner(maps, hookToolUseId, owner.subagentOwnerToolUseId);
      if (owner.launcherToolUseId) {
        rememberSubagentTaskBridge(maps, owner.launcherToolUseId, owner.subagentOwnerToolUseId);
      }
    }

    const finishedAtMs = Date.now();
    const failureSummary = failureSummaryFromMetadata(metadata, hookInput.tool_input, command);
    await callbacks.onToolFinished({
      summary: failureSummary,
      precedingToolUseIds: [hookToolUseId],
      subagentOwnerToolUseId: owner.subagentOwnerToolUseId,
      launcherToolUseId: owner.launcherToolUseId,
      ownershipReason: owner.ownershipReason,
      ...(owner.ownershipCandidates && owner.ownershipCandidates.length > 0
        ? { ownershipCandidates: owner.ownershipCandidates }
        : {}),
      ...(owner.activeSubagentToolUseIds && owner.activeSubagentToolUseIds.length > 0
        ? { activeSubagentToolUseIds: owner.activeSubagentToolUseIds }
        : {}),
      ...(metadata.editTarget
        ? { editTarget: metadata.editTarget }
        : {}),
      ...(metadata.isBash
        ? {
          command,
          shell: "bash" as const,
          isBash: true as const,
        }
        : metadata.searchParams
          ? { searchParams: metadata.searchParams }
          : {}),
      error: hookInput.error as string,
      truncated: false,
      outputBytes: Buffer.byteLength(hookInput.error as string, "utf8"),
    });
    const { timing } = buildFinishedTimingPreview(hookToolUseId, metadata, finishedAtMs, maps);
    await emitInstrumentation({
      stage: "failed",
      toolUseId: hookToolUseId,
      toolName: metadata?.toolName ?? (hookInput.tool_name as string),
      parentToolUseId: ownerParentToolUseId,
      summary: failureSummary,
      threadContext: instrumentContext,
      timing,
      preview: {
        ...(command ? { command } : {}),
        error: sanitizeForLog(hookInput.error as string) as string,
        truncated: false,
        outputBytes: Buffer.byteLength(hookInput.error as string, "utf8"),
      },
    });
    maps.finishedToolUseIds.add(hookToolUseId);
    return { continue: true };
  };
}

export function createSubagentStartHook(
  callbacks: HookCallbacks,
  maps: SessionMaps,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "SubagentStart") {
      return { continue: true };
    }

    const isKnownTaskToolUseId = (candidateToolUseId: string): boolean => {
      const metadata = maps.toolMetadataByUseId.get(candidateToolUseId);
      if (isSubagentLauncherToolName(metadata?.toolName)) {
        return true;
      }
      const requested = maps.requestedToolByUseId.get(candidateToolUseId);
      return isSubagentLauncherToolName(requested?.toolName);
    };

    const agentId = String(hookInput.agent_id ?? "");
    const agentType = String(hookInput.agent_type ?? "unknown");
    const subagentToolUseId = String(hookInput.tool_use_id || toolUseID || "");
    const parentToolUseId = String(hookInput.parent_tool_use_id ?? "");

    let taskToolUseId = "";

    if (subagentToolUseId) {
      taskToolUseId = maps.subagentTaskToolUseIdBySubagentToolUseId.get(subagentToolUseId) ?? "";
      if (!taskToolUseId && maps.subagentToolInputByUseId.has(subagentToolUseId) && isKnownTaskToolUseId(subagentToolUseId)) {
        taskToolUseId = subagentToolUseId;
      }
    }

    if (!taskToolUseId && parentToolUseId && maps.subagentToolInputByUseId.has(parentToolUseId) && isKnownTaskToolUseId(parentToolUseId)) {
      taskToolUseId = parentToolUseId;
    }

    if (!taskToolUseId) {
      const assignedTaskToolUseIds = new Set(maps.subagentTaskToolUseIdBySubagentToolUseId.values());
      while (maps.pendingSubagentTaskToolUseIds.length > 0) {
        const candidateTaskToolUseId = maps.pendingSubagentTaskToolUseIds.shift();
        if (!candidateTaskToolUseId) {
          break;
        }
        if (!maps.subagentToolInputByUseId.has(candidateTaskToolUseId)) {
          continue;
        }
        if (assignedTaskToolUseIds.has(candidateTaskToolUseId)) {
          continue;
        }
        const candidateDecision = maps.decisionByToolUseId.get(candidateTaskToolUseId);
        if (candidateDecision === "deny" || candidateDecision === "plan_deny") {
          continue;
        }
        taskToolUseId = candidateTaskToolUseId;
        break;
      }
    }

    if (subagentToolUseId && taskToolUseId) {
      maps.subagentTaskToolUseIdBySubagentToolUseId.set(subagentToolUseId, taskToolUseId);
      rememberSubagentTaskBridge(maps, taskToolUseId, subagentToolUseId);
    }

    if (agentId && subagentToolUseId) {
      maps.agentIdToToolUseId.set(agentId, subagentToolUseId);
    }

    if (subagentToolUseId) {
      rememberSubagentOwner(maps, subagentToolUseId, subagentToolUseId);
      if (taskToolUseId) {
        rememberSubagentOwner(maps, taskToolUseId, subagentToolUseId);
      }
      if (parentToolUseId) {
        rememberSubagentOwner(maps, parentToolUseId, subagentToolUseId);
      }
    }

    const toolInput = taskToolUseId
      ? maps.subagentToolInputByUseId.get(taskToolUseId)
      : undefined;
    if (subagentToolUseId && taskToolUseId && toolInput && !maps.subagentToolInputByUseId.has(subagentToolUseId)) {
      maps.subagentToolInputByUseId.set(subagentToolUseId, toolInput);
    }
    const description = toolInput
      ? String((toolInput as Record<string, unknown>).description
        ?? (toolInput as Record<string, unknown>).prompt
        ?? (toolInput as Record<string, unknown>).task
        ?? (toolInput as Record<string, unknown>).Task
        ?? "")
      : "";

    logSubagentDebug("subagent.start.mapping", {
      agentId,
      agentType,
      subagentToolUseId,
      parentToolUseId,
      taskToolUseId,
      mappingSource: subagentToolUseId && taskToolUseId && subagentToolUseId === taskToolUseId
        ? "subagentToolUseId"
        : parentToolUseId && taskToolUseId && parentToolUseId === taskToolUseId
          ? "parentToolUseId"
          : taskToolUseId
            ? "pendingTaskFallback"
            : "none",
      descriptionLength: description.length,
      pendingTaskQueueLength: maps.pendingSubagentTaskToolUseIds.length,
    });

    if (subagentToolUseId) {
      maps.activeSubagentToolUseIds.push(subagentToolUseId);
    }

    await callbacks.onSubagentStarted({
      agentId,
      agentType,
      toolUseId: subagentToolUseId,
      description,
    });

    return {};
  };
}

export function createSubagentStopHook(
  callbacks: HookCallbacks,
  maps: SessionMaps,
) {
  return async (hookInput: Record<string, unknown>, toolUseID?: string) => {
    if (hookInput.hook_event_name !== "SubagentStop") {
      return { continue: true };
    }

    const agentId = String(hookInput.agent_id ?? "");
    const agentType = String(hookInput.agent_type ?? "unknown");
    const subagentToolUseId = maps.agentIdToToolUseId.get(agentId)
      ?? String(hookInput.tool_use_id || toolUseID || "");
    const bridgedTaskToolUseId = subagentToolUseId
      ? maps.subagentTaskToolUseIdBySubagentToolUseId.get(subagentToolUseId) ?? ""
      : "";
    const taskToolUseId = bridgedTaskToolUseId
      || (subagentToolUseId && maps.subagentToolInputByUseId.has(subagentToolUseId)
        ? subagentToolUseId
        : "");

    let description = "";
    let lastMessage = "";
    const transcriptPath = String(hookInput.agent_transcript_path ?? "");
    if (transcriptPath) {
      try {
        const transcriptContent = readFileSync(transcriptPath, "utf-8");
        const parsed = parseSubagentTranscript(transcriptContent);
        description = parsed.description;
        lastMessage = parsed.lastMessage;
        logSubagentDebug("subagent.stop.transcriptParsed", {
          agentId,
          agentType,
          subagentToolUseId,
          bridgedTaskToolUseId,
          transcriptPath,
          transcriptReadSuccess: true,
          parsedDescriptionLength: description.length,
          parsedLastMessageLength: lastMessage.length,
        });
      } catch (err) {
        logSubagentDebug("subagent.stop.transcriptParsed", {
          agentId,
          agentType,
          subagentToolUseId,
          bridgedTaskToolUseId,
          transcriptPath,
          transcriptReadSuccess: false,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(`[SubagentStop] transcript read failed:`, err);
      }
    } else {
      logSubagentDebug("subagent.stop.transcriptParsed", {
        agentId,
        agentType,
        subagentToolUseId,
        bridgedTaskToolUseId,
        transcriptPath: null,
        transcriptReadSuccess: false,
        reason: "missing_path",
      });
    }

    if (subagentToolUseId) {
      rememberSubagentOwner(maps, subagentToolUseId, subagentToolUseId);
      maps.subagentTaskToolUseIdBySubagentToolUseId.delete(subagentToolUseId);
      if (subagentToolUseId !== taskToolUseId) {
        maps.subagentToolInputByUseId.delete(subagentToolUseId);
      }
    }

    if (taskToolUseId) {
      if (subagentToolUseId) {
        rememberSubagentTaskBridge(maps, taskToolUseId, subagentToolUseId);
      }
      maps.subagentToolInputByUseId.delete(taskToolUseId);
      maps.pendingSubagentTaskToolUseIds = maps.pendingSubagentTaskToolUseIds.filter((id) => id !== taskToolUseId);
    }

    logSubagentDebug("subagent.stop.finalPayload", {
      agentId,
      agentType,
      subagentToolUseId,
      taskToolUseId,
      descriptionLength: description.length,
      lastMessageLength: lastMessage.length,
    });

    await callbacks.onSubagentStopped({
      agentId,
      agentType,
      toolUseId: subagentToolUseId,
      description,
      lastMessage,
    });

    maps.agentIdToToolUseId.delete(agentId);
    maps.activeSubagentToolUseIds = maps.activeSubagentToolUseIds.filter((id) => id !== subagentToolUseId);

    return {};
  };
}
