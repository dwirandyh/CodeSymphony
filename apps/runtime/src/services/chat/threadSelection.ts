import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  hasSameThreadSelection,
  shouldPreserveThreadSelectionSessionIds,
  supportsModelProviderCompatibility,
  type ChatThreadKind,
  type CliAgent,
  type ModelProviderCompatibility,
  type ThreadSelectionLike,
} from "@codesymphony/shared-types";
import {
  isBuiltinCodexModelSelection,
  resolveAgentDefaultModel,
  resolveBuiltinCodexModelSelection,
} from "../../agentModelDefaults.js";
import type { RuntimeDeps } from "../../types.js";
import type { ActiveModelProvider } from "./chatService.types.js";

export type ThreadSelectionInput = {
  agent?: CliAgent | null;
  model?: string | null;
  modelProviderId?: string | null;
};

export type ResolvedThreadSelection = {
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
  provider: ActiveModelProvider | null;
};

type PersistedThreadSelection = ThreadSelectionLike & {
  kind: ChatThreadKind;
};

function normalizeAgent(agent: CliAgent | null | undefined): CliAgent {
  if (agent === "codex" || agent === "cursor" || agent === "opencode") {
    return agent;
  }

  return "claude";
}

function normalizeOptionalModelId(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const normalized = model.trim();
  return normalized.length > 0 ? normalized : null;
}

export function toRunnerOptional(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBuiltinModelForAgent(agent: CliAgent, model: string): boolean {
  if (agent === "codex") {
    // Codex built-ins now come from the app-server catalog, so any
    // providerless Codex model id should follow the local CLI override rules.
    return isBuiltinCodexModelSelection(model);
  }

  return (BUILTIN_CHAT_MODELS_BY_AGENT[agent] as readonly string[]).includes(model);
}

function resolveDefaultModelForAgent(agent: CliAgent): string {
  return resolveAgentDefaultModel(agent);
}

function resolveBuiltinModelSelection(agent: CliAgent, model: string): string {
  if (agent === "codex" && isBuiltinModelForAgent(agent, model)) {
    return resolveBuiltinCodexModelSelection(model);
  }

  return model;
}

function toActiveModelProvider(provider: {
  id: string;
  compatibility: ModelProviderCompatibility;
  apiKey: string | null;
  baseUrl: string | null;
  name: string;
  modelId: string;
}): ActiveModelProvider {
  return {
    id: provider.id,
    compatibility: provider.compatibility,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    name: provider.name,
    modelId: provider.modelId,
  };
}

export async function resolvePersistedThreadProvider(
  deps: RuntimeDeps,
  thread: { modelProviderId?: string | null; model?: string | null },
): Promise<ActiveModelProvider | null> {
  const providerId = normalizeOptionalModelId(thread.modelProviderId);
  const modelId = normalizeOptionalModelId(thread.model);
  if (!providerId || !modelId) {
    return null;
  }

  const provider = await deps.modelProviderService.resolveProviderSelection(providerId, modelId);
  return provider ? toActiveModelProvider(provider) : null;
}

export function isProviderBackedClaudeSelection(selection: {
  agent: CliAgent;
  provider: ActiveModelProvider | null;
}): boolean {
  return selection.agent === "claude" && Boolean(selection.provider?.baseUrl?.trim());
}

export async function resolveThreadSelection(
  deps: RuntimeDeps,
  input: ThreadSelectionInput,
): Promise<ResolvedThreadSelection> {
  const agent = normalizeAgent(input.agent);
  const requestedProviderId = normalizeOptionalModelId(input.modelProviderId);
  const explicitModel = normalizeOptionalModelId(input.model);

  if (requestedProviderId) {
    if (!explicitModel) {
      throw new Error("Selected model provider requires a model");
    }
    const provider = await deps.modelProviderService.resolveProviderSelection(requestedProviderId, explicitModel);
    if (!provider) {
      throw new Error("Selected model provider not found");
    }
    if (!supportsModelProviderCompatibility(agent, provider.compatibility)) {
      throw new Error(`Selected model provider is ${provider.compatibility}-compatible and cannot be used with ${agent}`);
    }

    return {
      agent,
      model: provider.modelId,
      modelProviderId: provider.id,
      provider: toActiveModelProvider(provider),
    };
  }


  if (explicitModel) {
    return {
      agent,
      model: resolveBuiltinModelSelection(agent, explicitModel),
      modelProviderId: null,
      provider: null,
    };
  }


  return {
    agent,
    model: resolveDefaultModelForAgent(agent),
    modelProviderId: null,
    provider: null,
  };
}

export function getRunnerForAgent(deps: RuntimeDeps, agent: CliAgent) {
  if (agent === "codex") {
    return deps.codexRunner ?? deps.claudeRunner;
  }
  if (agent === "cursor") {
    return deps.cursorRunner ?? deps.claudeRunner;
  }
  if (agent === "opencode") {
    return deps.opencodeRunner ?? deps.claudeRunner;
  }

  return deps.claudeRunner;
}

export function getThreadSessionId(
  thread: {
    claudeSessionId: string | null;
    codexSessionId: string | null;
    cursorSessionId?: string | null;
    opencodeSessionId?: string | null;
  },
  agent: CliAgent,
): string | null {
  if (agent === "codex") {
    return thread.codexSessionId;
  }
  if (agent === "cursor") {
    return thread.cursorSessionId ?? null;
  }
  if (agent === "opencode") {
    return thread.opencodeSessionId ?? null;
  }

  return thread.claudeSessionId;
}

export function buildSessionIdUpdate(agent: CliAgent, sessionId: string | null) {
  if (agent === "codex") {
    return { codexSessionId: sessionId };
  }
  if (agent === "cursor") {
    return { cursorSessionId: sessionId };
  }
  if (agent === "opencode") {
    return { opencodeSessionId: sessionId };
  }

  return { claudeSessionId: sessionId };
}

export function buildSelectionUpdate(
  selection: ResolvedThreadSelection,
  options?: { resetSessionIds?: boolean },
) {
  const baseUpdate = {
    agent: selection.agent,
    model: selection.model,
    modelProviderId: selection.modelProviderId,
  };

  if (options?.resetSessionIds === false) {
    return baseUpdate;
  }

  return {
    ...baseUpdate,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    opencodeSessionId: null,
  };
}

export async function prepareThreadSelectionUpdate(params: {
  deps: RuntimeDeps;
  thread: PersistedThreadSelection;
  input: ThreadSelectionInput;
  messageCount: number;
}): Promise<{
  selection: ResolvedThreadSelection;
  selectionChanged: boolean;
  selectionUpdate: ReturnType<typeof buildSelectionUpdate> | null;
}> {
  const selection = await resolveThreadSelection(params.deps, params.input);
  const selectionChanged = !hasSameThreadSelection(params.thread, selection);
  if (!selectionChanged) {
    return {
      selection,
      selectionChanged,
      selectionUpdate: null,
    };
  }

  if (params.messageCount > 0) {
    if (params.thread.kind !== "default") {
      throw new Error("Cannot change model for non-default threads");
    }

    if (params.thread.agent !== selection.agent) {
      throw new Error("Cannot change agent after the thread has messages");
    }

    const currentProvider = await resolvePersistedThreadProvider(params.deps, params.thread);
    if (isProviderBackedClaudeSelection({
      agent: params.thread.agent,
      provider: currentProvider,
    })) {
      throw new Error("Cannot change model for provider-backed Claude threads");
    }

    const currentProviderId = normalizeOptionalModelId(params.thread.modelProviderId);
    const nextProviderId = normalizeOptionalModelId(selection.modelProviderId);
    if (currentProviderId !== nextProviderId) {
      throw new Error("Cannot change provider source after the thread has messages");
    }
  }

  const preserveSessionIds = shouldPreserveThreadSelectionSessionIds({
    threadKind: params.thread.kind,
    currentAgent: params.thread.agent,
    currentModel: params.thread.model,
    currentModelProviderId: params.thread.modelProviderId,
    nextAgent: selection.agent,
    nextModel: selection.model,
    nextModelProviderId: selection.modelProviderId,
  });

  return {
    selection,
    selectionChanged,
    selectionUpdate: buildSelectionUpdate(selection, {
      resetSessionIds: params.messageCount === 0 || !preserveSessionIds,
    }),
  };
}
