import {
  DEFAULT_CHAT_MODEL_BY_AGENT,
  type SlashCommand,
  resolveCursorSdkModelSelection,
} from "@codesymphony/shared-types";
import type { ChatAgentRunner } from "../types.js";
import { appendRuntimeDebugLog } from "../routes/debug.js";
import { assertCursorSdkProviderConfig, resolveCursorApiKey } from "./sdk/auth.js";
import {
  listCursorSdkModelCatalog,
  listCursorSdkModels,
  listCursorSdkSlashCommands,
} from "./sdk/catalog.js";
import { loadCursorSdkMcpServers } from "./sdk/mcpServers.js";
import { runCursorSdkTurn } from "./sdk/runTurn.js";

export async function listCursorSlashCommands(params: {
  cwd: string;
}): Promise<SlashCommand[]> {
  return listCursorSdkSlashCommands(params);
}

export async function listCursorModels(_params: {
  cwd: string;
}): Promise<Array<{ id: string; name: string }>> {
  return listCursorSdkModels({ apiKey: resolveCursorApiKey() });
}

export const runCursorWithStreaming: ChatAgentRunner = async ({
  prompt,
  promptWithAttachments,
  sessionId,
  cwd,
  abortController,
  onSessionId,
  permissionMode,
  threadPermissionMode,
  model,
  modelOptions,
  providerApiKey,
  providerBaseUrl,
  onText,
  onToolStarted,
  onToolOutput,
  onToolFinished,
  onQuestionRequest,
  onPermissionRequest,
  onPlanFileDetected,
  onTodoUpdate,
  onSubagentStarted,
  onSubagentStopped,
  onThinking,
}) => {
  assertCursorSdkProviderConfig({ providerApiKey, providerBaseUrl });
  const apiKey = resolveCursorApiKey();
  const baseModel = model?.trim() || DEFAULT_CHAT_MODEL_BY_AGENT.cursor;
  const catalog = await listCursorSdkModelCatalog({ apiKey });
  const sdkModel = resolveCursorSdkModelSelection({
    model: baseModel,
    modelOptions,
    catalog,
  });

  appendRuntimeDebugLog({
    source: "cursor.sdk.modelResolved",
    message: "model.resolution",
    data: {
      requestedModel: baseModel,
      modelOptions: modelOptions ?? null,
      sdkModel,
      catalogModelCount: catalog.length,
    },
  });

  return runCursorSdkTurn({
    prompt: promptWithAttachments ?? prompt,
    sessionId,
    cwd,
    apiKey,
    abortController,
    permissionMode,
    threadPermissionMode,
    model: sdkModel,
    mcpServers: loadCursorSdkMcpServers(),
    onSessionId,
    onText,
    onToolStarted,
    onToolOutput,
    onToolFinished,
    onQuestionRequest,
    onPermissionRequest,
    onPlanFileDetected,
    onTodoUpdate,
    onSubagentStarted,
    onSubagentStopped,
    onThinking,
  });
};
