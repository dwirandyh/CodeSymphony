import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { ClaudeToolInstrumentationEvent, PlanDetectionSource } from "../../types.js";

const CLAUDE_SETTINGS_DIR = ".claude";
const CLAUDE_LOCAL_SETTINGS_FILE = "settings.local.json";

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function buildPromptWithAttachments(content: string, attachments: Array<{ filename: string; mimeType: string; content: string; storagePath: string | null }>): string {
  const cleanContent = content.replace(/\{\{attachment:[^}]+\}\}/g, "").trim();

  if (attachments.length === 0) return cleanContent;

  const attachmentBlocks = attachments.map((att) => {
    if (isImageMimeType(att.mimeType) && att.storagePath) {
      return `<attachment filename="${att.filename}" type="${att.mimeType}" path="${att.storagePath}">[Image saved at path. Use Read tool to view.]</attachment>`;
    }
    return `<attachment filename="${att.filename}" type="${att.mimeType}">${att.content}</attachment>`;
  });

  return `${cleanContent}\n\n${attachmentBlocks.join("\n\n")}`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel|interrupt/i.test(error.message));
}

export function instrumentationMessage(event: ClaudeToolInstrumentationEvent): string {
  if (event.stage === "anomaly") {
    return event.anomaly?.message ?? `Tool anomaly (${event.toolName})`;
  }

  if (event.stage === "decision") {
    return `${event.toolName} decision: ${event.decision ?? "unknown"}`;
  }

  if (event.stage === "requested") {
    return `${event.toolName} requested`;
  }

  if (event.stage === "started") {
    return `${event.toolName} started`;
  }

  if (event.stage === "failed") {
    return `${event.toolName} failed`;
  }

  return event.summary?.trim().length ? event.summary : `${event.toolName} finished`;
}

export async function nextMessageSeq(prisma: PrismaClient, threadId: string): Promise<number> {
  const result = await prisma.chatMessage.aggregate({
    where: { threadId },
    _max: { seq: true },
  });

  return (result._max.seq ?? -1) + 1;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function persistAlwaysAllowRule(worktreePath: string, rule: string): { settingsPath: string; persisted: boolean } {
  const claudeDirPath = join(worktreePath, CLAUDE_SETTINGS_DIR);
  const settingsPath = join(claudeDirPath, CLAUDE_LOCAL_SETTINGS_FILE);

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
        throw new Error("settings.local.json must contain a JSON object.");
      }
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${settingsPath}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const existingPermissions =
    typeof settings.permissions === "object" && settings.permissions != null && !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {};

  const allow = toStringArray(existingPermissions.allow);
  const persisted = !allow.includes(rule);
  if (persisted) {
    allow.push(rule);
  }

  const nextSettings: Record<string, unknown> = {
    ...settings,
    permissions: {
      ...existingPermissions,
      allow,
      deny: toStringArray(existingPermissions.deny),
      ask: toStringArray(existingPermissions.ask),
    },
  };

  mkdirSync(claudeDirPath, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  return { settingsPath, persisted };
}

export function inferPlanDetectionSource(filePath: string, source?: PlanDetectionSource): PlanDetectionSource {
  if (source === "claude_plan_file" || source === "streaming_fallback") {
    return source;
  }

  if (!filePath.endsWith(".md")) return "streaming_fallback";
  if (filePath.includes(".claude/plans/") || filePath.includes("codesymphony-claude-provider/plans/")) return "claude_plan_file";
  return "streaming_fallback";
}
