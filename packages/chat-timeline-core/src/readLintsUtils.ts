import type { ChatEvent } from "@codesymphony/shared-types";
import { shortenReadTargetForDisplay } from "./exploreUtils.js";
import { isRecord, payloadStringOrNull } from "./eventUtils.js";

type ReadLintsPayload = {
  paths: string[];
  totalDiagnostics: number | null;
};

export function isReadLintsToolName(toolName: string | null | undefined): boolean {
  return toolName?.trim().toLowerCase() === "readlints";
}

export function readPathsFromToolInput(event: ChatEvent): string[] {
  const toolInput = isRecord(event.payload.toolInput) ? event.payload.toolInput : null;
  if (!toolInput) {
    return [];
  }

  const singlePath = payloadStringOrNull(toolInput.path)
    ?? payloadStringOrNull(toolInput.file_path)
    ?? payloadStringOrNull(toolInput.filePath);
  if (singlePath) {
    return [singlePath];
  }

  const paths = toolInput.paths;
  if (!Array.isArray(paths)) {
    return [];
  }

  return paths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function parseReadLintsPayload(text: string | null | undefined): ReadLintsPayload | null {
  if (!text || text.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || parsed.status !== "success") {
      return null;
    }

    const value = isRecord(parsed.value) ? parsed.value : null;
    if (!value) {
      return null;
    }

    const fileDiagnostics = Array.isArray(value.fileDiagnostics) ? value.fileDiagnostics : [];
    const paths = fileDiagnostics
      .map((entry) => (isRecord(entry) ? payloadStringOrNull(entry.path) : null))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    const totalDiagnostics = typeof value.totalDiagnostics === "number" ? value.totalDiagnostics : null;

    return {
      paths,
      totalDiagnostics,
    };
  } catch {
    return null;
  }
}

export function buildReadLintsLabel(paths: string[], totalDiagnostics: number | null): string {
  const issueLabel = totalDiagnostics == null
    ? null
    : `${totalDiagnostics} issue${totalDiagnostics === 1 ? "" : "s"}`;

  if (paths.length === 1) {
    const basename = shortenReadTargetForDisplay(paths[0]);
    return issueLabel ? `Checked lints ${basename} (${issueLabel})` : `Checked lints ${basename}`;
  }

  if (paths.length > 1) {
    return issueLabel
      ? `Checked lints ${paths.length} files (${issueLabel})`
      : `Checked lints ${paths.length} files`;
  }

  return issueLabel ? `Checked lints (${issueLabel})` : "Checked lints";
}

export function resolveReadLintsSummary(event: ChatEvent): string {
  const rawSummary = payloadStringOrNull(event.payload.summary)?.trim() ?? "";
  if (/^checked lints\b/i.test(rawSummary)) {
    return rawSummary;
  }

  const parsedFromSummary = parseReadLintsPayload(rawSummary);
  const parsedFromOutput = parseReadLintsPayload(payloadStringOrNull(event.payload.output));
  const parsed = parsedFromSummary ?? parsedFromOutput;
  const paths = readPathsFromToolInput(event);
  const resolvedPaths = paths.length > 0 ? paths : (parsed?.paths ?? []);

  if (parsed || resolvedPaths.length > 0) {
    return buildReadLintsLabel(resolvedPaths, parsed?.totalDiagnostics ?? null);
  }

  if (rawSummary.length > 0) {
    return rawSummary;
  }

  return "Checked lints";
}

export function resolveReadLintsSubtitle(event: ChatEvent): string {
  return resolveReadLintsSummary(event).replace(/^checked lints\s+/i, "");
}

export function shouldSuppressReadLintsOutput(output: string | null | undefined): boolean {
  const parsed = parseReadLintsPayload(output);
  if (!parsed) {
    return false;
  }

  return parsed.totalDiagnostics === 0;
}