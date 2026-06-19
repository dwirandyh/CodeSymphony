import {
  DEFAULT_CHAT_MODEL_BY_AGENT,
  type CursorModelCatalogEntry,
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
  resolveSdkModelDefaultVariantParams,
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
}): Promise<CursorModelCatalogEntry[]> {
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
  const catalogEntry = catalog.find((entry) => entry.id === sdkModel.id);

  appendRuntimeDebugLog({
    source: "cursor.sdk.modelResolved",
    message: "model.resolution",
    data: {
      requestedModel: baseModel,
      modelOptions: modelOptions ?? null,
      sdkModel,
      catalogModelCount: catalog.length,
      catalogEntryDefaultVariantParams: catalogEntry
        ? resolveSdkModelDefaultVariantParams(catalogEntry) ?? null
        : null,
      catalogEntryParameterIds: catalogEntry?.parameters?.map((p) => p.id) ?? null,
      catalogReasoningParamValues: catalogEntry?.parameters?.find((p) => (
        p.id === "thinking" || p.id === "reasoning" || p.id === "effort"
      ))?.values?.map((v) => v.value) ?? null,
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
