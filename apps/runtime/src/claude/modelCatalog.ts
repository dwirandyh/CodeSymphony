import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeModelCatalogEntry } from "@codesymphony/shared-types";
import { buildClaudeRuntimeEnv } from "./shellEnv.js";
import {
  captureStderrLine,
  withClaudeSetupHint,
} from "./executableResolver.js";

function toClaudeModelCatalogEntry(entry: {
  value?: string;
  displayName?: string;
  description?: string;
}): ClaudeModelCatalogEntry | null {
  const id = entry.value?.trim();
  if (!id) {
    return null;
  }

  return {
    id,
    name: entry.displayName?.trim() || id,
    description: entry.description?.trim() || "",
  };
}

export async function listClaudeModels(params: {
  cwd: string;
}): Promise<ClaudeModelCatalogEntry[]> {
  const recentStderr: string[] = [];
  const runtimeEnv = buildClaudeRuntimeEnv({
    ...process.env,
  } as NodeJS.ProcessEnv);
  const stream = query({
    prompt: "",
    options: {
      cwd: params.cwd,
      env: runtimeEnv,
      persistSession: false,
      tools: [],
      stderr: (data: string) => {
        captureStderrLine(recentStderr, data);
      },
    },
  });

  try {
    const supportedModels = await stream.supportedModels();
    const dedupedModels = new Map<string, ClaudeModelCatalogEntry>();

    for (const entry of supportedModels) {
      const normalizedEntry = toClaudeModelCatalogEntry(entry);
      if (!normalizedEntry || dedupedModels.has(normalizedEntry.id)) {
        continue;
      }
      dedupedModels.set(normalizedEntry.id, normalizedEntry);
    }

    const models = Array.from(dedupedModels.values());
    if (models.length === 0) {
      throw new Error("Claude CLI returned an empty model catalog.");
    }

    return models;
  } catch (error) {
    throw withClaudeSetupHint(error, recentStderr, [], process.env.CLAUDE_CODE_EXECUTABLE?.trim() || "claude");
  } finally {
    stream.close();
  }
}
