import type { ChatEvent } from "@codesymphony/shared-types";
import { EDIT_TOOL_NAME_PATTERN } from "./constants";
import {
  countDiffStats,
  filterDiffByFiles,
  finishedToolUseIds,
  isRecord,
  isWorktreeDiffEvent,
  payloadStringArray,
  payloadStringOrNull,
} from "./eventUtils";
import type { EditedRun } from "./types";

export function isEditToolName(toolName: string | null): boolean {
  if (!toolName) {
    return false;
  }

  return EDIT_TOOL_NAME_PATTERN.test(toolName.trim());
}

export function extractEditTargetFromUnknownToolInput(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const keyCandidates = ["file_path", "filePath", "path", "file", "filepath", "target", "filename"];
  for (const key of keyCandidates) {
    const value = payloadStringOrNull(input[key]);
    if (value) {
      return value.trim();
    }
  }

  return null;
}

export function extractEditTargetFromSummary(summary: string): string | null {
  const editedMatch = /^Edited\s+(.+)$/i.exec(summary.trim());
  if (editedMatch?.[1]) {
    const candidate = editedMatch[1].trim();
    if (!/^(\d+\s+files?|files?|changes?)$/i.test(candidate)) {
      return candidate;
    }
    return null;
  }

  const failedMatch = /^Failed to edit\s+(.+)$/i.exec(summary.trim());
  if (failedMatch?.[1]) {
    return failedMatch[1].trim();
  }

  return null;
}

export function buildProposedEditDiffFromToolInput(toolInput: unknown, filePath: string): string | null {
  if (!isRecord(toolInput)) {
    return null;
  }

  function extractEditBlock(record: Record<string, unknown>): { oldText: string | null; newText: string | null } | null {
    const oldText =
      payloadStringOrNull(record.old_string)
      ?? payloadStringOrNull(record.old_text)
      ?? payloadStringOrNull(record.old)
      ?? null;
    const newText =
      payloadStringOrNull(record.new_string)
      ?? payloadStringOrNull(record.new_text)
      ?? payloadStringOrNull(record.new)
      ?? payloadStringOrNull(record.content)
      ?? payloadStringOrNull(record.new_content)
      ?? null;
    if (!oldText && !newText) {
      return null;
    }
    return { oldText, newText };
  }

  const blocks: Array<{ oldText: string | null; newText: string | null }> = [];
  const rootBlock = extractEditBlock(toolInput);
  if (rootBlock) {
    blocks.push(rootBlock);
  }

  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!isRecord(edit)) {
        continue;
      }
      const block = extractEditBlock(edit);
      if (block) {
        blocks.push(block);
      }
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  for (const block of blocks) {
    const oldLines = block.oldText ? block.oldText.split(/\r?\n/) : [];
    const newLines = block.newText ? block.newText.split(/\r?\n/) : [];
    const oldStart = oldLines.length === 0 ? "1,0" : oldLines.length === 1 ? "1" : `1,${oldLines.length}`;
    const newStart = newLines.length === 0 ? "1,0" : newLines.length === 1 ? "1" : `1,${newLines.length}`;
    lines.push(`@@ -${oldStart} +${newStart} @@`);
    lines.push(...oldLines.map((line) => `-${line}`));
    lines.push(...newLines.map((line) => `+${line}`));
  }

  return lines.join("\n");
}

export function isEditToolLifecycleEvent(event: ChatEvent): boolean {
  if (event.type === "tool.started" || event.type === "tool.output") {
    const toolName = payloadStringOrNull(event.payload.toolName);
    return isEditToolName(toolName);
  }

  if (event.type === "tool.finished") {
    if (event.payload.source === "worktree.diff") {
      return false;
    }
    const toolName = payloadStringOrNull(event.payload.toolName);
    if (isEditToolName(toolName)) {
      return true;
    }
    const summary = payloadStringOrNull(event.payload.summary);
    return Boolean(summary && extractEditTargetFromSummary(summary));
  }

  if (event.type === "permission.requested") {
    const toolName = payloadStringOrNull(event.payload.toolName);
    return isEditToolName(toolName);
  }

  return false;
}

export function extractEditedRuns(context: ChatEvent[], fullContext?: ChatEvent[]): EditedRun[] {
  const ordered = [...context].sort((a, b) => a.idx - b.idx);
  const byRunKey = new Map<string, EditedRun>();
  const toolNameByUseId = new Map<string, string>();
  const permissionRequestIds = new Set<string>();
  const claimedPermissionRequestIds = new Set<string>();
  const toolLifecycleRunKeys = new Set<string>();

  for (const event of [...(fullContext ?? ordered)].sort((a, b) => a.idx - b.idx)) {
    if (event.type !== "tool.started" && event.type !== "tool.output") {
      continue;
    }

    const toolUseId = payloadStringOrNull(event.payload.toolUseId);
    const toolName = payloadStringOrNull(event.payload.toolName);
    if (!toolUseId || !toolName) {
      continue;
    }

    toolNameByUseId.set(toolUseId, toolName);
  }

  function ensureRun(
    runKey: string,
    event: ChatEvent,
    options?: { startIdx?: number; anchorIdx?: number },
  ): EditedRun {
    const existing = byRunKey.get(runKey);
    const nextStartIdx = options?.startIdx ?? event.idx;
    const nextAnchorIdx = options?.anchorIdx ?? nextStartIdx;
    if (existing) {
      existing.startIdx = Math.min(existing.startIdx, nextStartIdx);
      existing.anchorIdx = Math.min(existing.anchorIdx, nextAnchorIdx);
      existing.eventIds.add(event.id);
      return existing;
    }

    const created: EditedRun = {
      id: `edited:${runKey}`,
      eventId: event.id,
      startIdx: nextStartIdx,
      anchorIdx: nextAnchorIdx,
      endIdx: nextStartIdx,
      changeSource: "edit-tool",
      status: "running",
      diffKind: "none",
      changedFiles: [],
      diff: "",
      diffTruncated: false,
      additions: 0,
      deletions: 0,
      rejectedByUser: false,
      createdAt: event.createdAt,
      eventIds: new Set([event.id]),
    };
    byRunKey.set(runKey, created);
    return created;
  }

  function uniqueRuns(): EditedRun[] {
    return Array.from(new Set(byRunKey.values()));
  }

  function targetsLikelyMatch(left: string, right: string): boolean {
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  }

  function diffKindPriority(diffKind: EditedRun["diffKind"]): number {
    if (diffKind === "actual") {
      return 2;
    }
    if (diffKind === "proposed") {
      return 1;
    }
    return 0;
  }

  function runTargetsFile(run: EditedRun, target: string): boolean {
    return run.changedFiles.some((changedFile) => targetsLikelyMatch(changedFile, target));
  }

  function mergeRunInto(destination: EditedRun, source: EditedRun): void {
    const sourceStartsEarlier = source.startIdx < destination.startIdx
      || (source.startIdx === destination.startIdx && source.anchorIdx < destination.anchorIdx);
    destination.startIdx = Math.min(destination.startIdx, source.startIdx);
    destination.anchorIdx = Math.min(destination.anchorIdx, source.anchorIdx);
    destination.endIdx = Math.max(destination.endIdx, source.endIdx);
    if (sourceStartsEarlier) {
      destination.createdAt = source.createdAt;
    }

    source.eventIds.forEach((eventId) => destination.eventIds.add(eventId));
    for (const changedFile of source.changedFiles) {
      if (!destination.changedFiles.some((existing) => targetsLikelyMatch(existing, changedFile))) {
        destination.changedFiles.push(changedFile);
      }
    }

    if (source.changeSource === "worktree-diff") {
      destination.changeSource = "worktree-diff";
    }

    const destinationDiffRank = diffKindPriority(destination.diffKind);
    const sourceDiffRank = diffKindPriority(source.diffKind);
    if (
      sourceDiffRank > destinationDiffRank
      || (
        sourceDiffRank === destinationDiffRank
        && destination.diff.trim().length === 0
        && source.diff.trim().length > 0
      )
    ) {
      destination.eventId = source.eventId;
      destination.diffKind = source.diffKind;
      destination.diff = source.diff;
      destination.diffTruncated = source.diffTruncated;
      destination.additions = source.additions;
      destination.deletions = source.deletions;
    }

    if (destination.status !== "failed") {
      if (source.status === "failed") {
        destination.status = "failed";
      } else if (source.status === "success") {
        destination.status = "success";
      }
    }

    destination.rejectedByUser = destination.rejectedByUser || source.rejectedByUser;
  }

  function findClaimablePermissionRun(
    target: string | null,
    event: ChatEvent,
  ): { requestId: string; run: EditedRun } | null {
    const candidates = Array.from(permissionRequestIds)
      .filter((requestId) => !claimedPermissionRequestIds.has(requestId))
      .map((requestId) => ({ requestId, run: byRunKey.get(requestId) ?? null }))
      .filter((entry): entry is { requestId: string; run: EditedRun } =>
        entry.run != null
        && entry.run.startIdx <= event.idx
        && entry.run.status !== "failed",
      )
      .filter((entry) => target == null || runTargetsFile(entry.run, target))
      .sort((a, b) => b.run.startIdx - a.run.startIdx);

    return candidates[0] ?? null;
  }

  function claimPermissionRunForToolKey(
    runKey: string,
    target: string | null,
    event: ChatEvent,
  ): EditedRun | null {
    const existing = byRunKey.get(runKey) ?? null;
    if (existing) {
      if (target == null) {
        return existing;
      }

      const matched = findClaimablePermissionRun(target, event);
      if (!matched) {
        return existing;
      }
      if (matched.run === existing) {
        return existing;
      }

      claimedPermissionRequestIds.add(matched.requestId);
      existing.id = `edited:${runKey}`;
      mergeRunInto(existing, matched.run);
      byRunKey.set(matched.requestId, existing);
      byRunKey.set(runKey, existing);
      return existing;
    }

    const matched = findClaimablePermissionRun(target, event);
    if (!matched) {
      return null;
    }

    claimedPermissionRequestIds.add(matched.requestId);
    matched.run.id = `edited:${runKey}`;
    byRunKey.set(runKey, matched.run);
    return matched.run;
  }

  function attachPermissionKeyToExistingToolRun(
    requestId: string,
    target: string | null,
    event: ChatEvent,
  ): EditedRun | null {
    if (byRunKey.has(requestId)) {
      return byRunKey.get(requestId) ?? null;
    }

    if (target == null) {
      return null;
    }

    const candidates = Array.from(toolLifecycleRunKeys)
      .map((runKey) => byRunKey.get(runKey) ?? null)
      .filter((run): run is EditedRun =>
        run != null
        && run.startIdx <= event.idx
        && run.status === "running"
        && runTargetsFile(run, target),
      )
      .sort((a, b) => b.startIdx - a.startIdx);

    const matched = candidates[0];
    if (!matched) {
      return null;
    }

    byRunKey.set(requestId, matched);
    return matched;
  }

  function ensureToolRun(
    runKey: string,
    event: ChatEvent,
    explicitTarget: string | null,
  ): EditedRun {
    toolLifecycleRunKeys.add(runKey);
    const claimedRun = claimPermissionRunForToolKey(runKey, explicitTarget, event);
    if (claimedRun) {
      claimedRun.startIdx = Math.min(claimedRun.startIdx, event.idx);
      claimedRun.anchorIdx = Math.min(claimedRun.anchorIdx, event.idx);
      claimedRun.eventIds.add(event.id);
      return claimedRun;
    }

    return ensureRun(runKey, event);
  }

  function setRunTargetIfPresent(run: EditedRun, target: string | null): void {
    if (!target) {
      return;
    }
    if (!run.changedFiles.some((changedFile) => targetsLikelyMatch(changedFile, target))) {
      run.changedFiles.push(target);
    }
  }

  function markRunFinishedFromEvent(run: EditedRun, event: ChatEvent): void {
    const hasError = payloadStringOrNull(event.payload.error);
    const summary = payloadStringOrNull(event.payload.summary);
    const summaryLower = (summary ?? "").toLowerCase();
    run.status = hasError || summaryLower.includes("failed") || summaryLower.includes("error") ? "failed" : "success";
    if (run.status !== "failed") {
      run.rejectedByUser = false;
    }
  }

  function applyActualDiffToRun(
    run: EditedRun,
    event: ChatEvent,
    diff: string,
    changedFiles: string[],
  ): boolean {
    const nextDiff = run.changedFiles.length > 0 ? filterDiffByFiles(diff, run.changedFiles) : diff;
    if (run.changedFiles.length > 0 && nextDiff.trim().length === 0) {
      return false;
    }

    run.eventId = event.id;
    run.status = "success";
    run.diffKind = "actual";
    run.diffTruncated = event.payload.diffTruncated === true;
    run.rejectedByUser = false;
    run.eventIds.add(event.id);
    run.diff = nextDiff;
    const stats = countDiffStats(nextDiff);
    run.additions = stats.additions;
    run.deletions = stats.deletions;
    if (run.changedFiles.length === 0 && changedFiles.length > 0) {
      run.changedFiles = changedFiles;
    }
    return true;
  }

  function selectBestRunForChangedFile(
    changedFile: string,
    candidates: EditedRun[],
  ): EditedRun | null {
    for (const run of candidates) {
      if (run.changedFiles.length === 0) {
        continue;
      }
      if (filterDiffByFiles(`diff --git a/${changedFile} b/${changedFile}\n`, run.changedFiles).trim().length > 0) {
        return run;
      }
    }
    return null;
  }

  for (const event of ordered) {
    if (event.type === "permission.requested") {
      if (!isEditToolLifecycleEvent(event)) {
        continue;
      }
      const requestId = payloadStringOrNull(event.payload.requestId) ?? `permission:${event.id}`;
      const toolInput = isRecord(event.payload.toolInput) ? event.payload.toolInput : null;
      const target =
        payloadStringOrNull(event.payload.editTarget)
        ?? payloadStringOrNull(event.payload.blockedPath)
        ?? extractEditTargetFromUnknownToolInput(toolInput)
        ?? null;
      permissionRequestIds.add(requestId);
      const run = attachPermissionKeyToExistingToolRun(requestId, target, event) ?? ensureRun(requestId, event);
      run.status = "running";
      run.rejectedByUser = false;
      setRunTargetIfPresent(run, target);
      if (toolInput && target) {
        const proposedDiff = buildProposedEditDiffFromToolInput(toolInput, target);
        if (proposedDiff && run.diffKind !== "actual") {
          run.diff = proposedDiff;
          run.diffKind = "proposed";
          run.diffTruncated = false;
          const { additions, deletions } = countDiffStats(proposedDiff);
          run.additions = additions;
          run.deletions = deletions;
        }
      }
      continue;
    }

    if (event.type === "permission.resolved") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      if (!requestId) {
        continue;
      }
      const run = byRunKey.get(requestId);
      if (!run) {
        continue;
      }
      run.eventIds.add(event.id);
      const decision = payloadStringOrNull(event.payload.decision);
      if (decision === "deny") {
        run.status = "failed";
        run.rejectedByUser = true;
      } else if (decision === "allow" || decision === "allow_always") {
        run.rejectedByUser = false;
      }
      continue;
    }

    if (event.type === "tool.started" || event.type === "tool.output") {
      if (!isEditToolLifecycleEvent(event)) {
        continue;
      }
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? `${event.type}:${event.id}`;
      const toolInput = isRecord(event.payload.toolInput) ? event.payload.toolInput : null;
      const explicitTarget =
        payloadStringOrNull(event.payload.editTarget)
        ?? payloadStringOrNull(event.payload.blockedPath)
        ?? extractEditTargetFromUnknownToolInput(toolInput)
        ?? null;
      const run = ensureToolRun(toolUseId, event, explicitTarget);
      if (run.status !== "failed") {
        run.status = "running";
      }
      setRunTargetIfPresent(run, explicitTarget);
      if (toolInput && explicitTarget && run.diffKind === "none") {
        const proposedDiff = buildProposedEditDiffFromToolInput(toolInput, explicitTarget);
        if (proposedDiff) {
          run.diff = proposedDiff;
          run.diffKind = "proposed";
          run.diffTruncated = false;
          const { additions, deletions } = countDiffStats(proposedDiff);
          run.additions = additions;
          run.deletions = deletions;
        }
      }
      continue;
    }

    if (event.type === "tool.finished" && !isWorktreeDiffEvent(event)) {
      const runIds = finishedToolUseIds(event);
      const finishedToolName = payloadStringOrNull(event.payload.toolName)
        ?? runIds.map((runId) => toolNameByUseId.get(runId) ?? null).find((toolName) => toolName != null)
        ?? null;
      const summary = payloadStringOrNull(event.payload.summary);
      const summaryTarget = summary ? extractEditTargetFromSummary(summary) : null;
      const toolInput = isRecord(event.payload.toolInput) ? event.payload.toolInput : null;
      const explicitTarget =
        payloadStringOrNull(event.payload.editTarget)
        ?? (isEditToolName(finishedToolName) ? extractEditTargetFromUnknownToolInput(toolInput) : null)
        ?? summaryTarget;
      const proposedDiff =
        toolInput && explicitTarget
          ? buildProposedEditDiffFromToolInput(toolInput, explicitTarget)
          : null;
      const isEditFinishedEvent =
        isEditToolName(finishedToolName)
        || summaryTarget != null
        || proposedDiff != null;

      function applyProposedDiffIfNeeded(run: EditedRun): void {
        if (proposedDiff && run.diffKind === "none" && run.status !== "failed") {
          run.diff = proposedDiff;
          run.diffKind = "proposed";
          run.diffTruncated = false;
          const { additions, deletions } = countDiffStats(proposedDiff);
          run.additions = additions;
          run.deletions = deletions;
        }
      }

      let matchedRun = false;
      for (const runId of runIds) {
        const existing = byRunKey.get(runId);
        const shouldTrack = existing || isEditFinishedEvent;
        if (!shouldTrack) {
          continue;
        }
        const run = ensureToolRun(runId, event, explicitTarget);
        setRunTargetIfPresent(run, explicitTarget);
        run.endIdx = Math.max(run.endIdx, event.idx);
        markRunFinishedFromEvent(run, event);
        applyProposedDiffIfNeeded(run);
        matchedRun = true;
      }

      if (!matchedRun && isEditFinishedEvent) {
        const fallbackKey = `finished:${event.id}`;
        const run = ensureToolRun(fallbackKey, event, explicitTarget);
        setRunTargetIfPresent(run, explicitTarget);
        run.endIdx = Math.max(run.endIdx, event.idx);
        markRunFinishedFromEvent(run, event);
        applyProposedDiffIfNeeded(run);
      }
      continue;
    }

    if (!isWorktreeDiffEvent(event)) {
      continue;
    }

    const diff = payloadStringOrNull(event.payload.diff) ?? "";
    const changedFiles = payloadStringArray(event.payload.changedFiles);
    const eligibleRuns = uniqueRuns()
      .filter((run) => run.startIdx <= event.idx && (run.diffKind === "none" || run.diffKind === "proposed") && run.status !== "failed")
      .sort((a, b) => b.startIdx - a.startIdx);

    const assignedRuns = new Set<EditedRun>();
    const matchedRuns: EditedRun[] = [];
    for (const changedFile of changedFiles) {
      const candidateRuns = eligibleRuns.filter((run) => !assignedRuns.has(run));
      const matchedRun = selectBestRunForChangedFile(changedFile, candidateRuns);
      if (!matchedRun) {
        continue;
      }
      assignedRuns.add(matchedRun);
      matchedRuns.push(matchedRun);
    }

    if (matchedRuns.length > 0) {
      matchedRuns.forEach((run) => {
        applyActualDiffToRun(run, event, diff, changedFiles);
      });
      continue;
    }

    const targetRun = eligibleRuns[0];

    if (!targetRun) {
      const hasRunsWithDiffs = uniqueRuns().some((run) => run.diffKind !== "none");
      if (hasRunsWithDiffs) {
        continue;
      }
    }

    const run = targetRun
      ?? ensureRun(`worktree:${event.id}`, event, {
        startIdx: event.idx,
        anchorIdx: event.idx,
      });
    run.changeSource = "worktree-diff";
    applyActualDiffToRun(run, event, diff, changedFiles);
  }

  const result = uniqueRuns().sort((a, b) => a.startIdx - b.startIdx);
  return result;
}
