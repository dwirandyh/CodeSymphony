import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  DEFAULT_CHAT_MODEL_BY_AGENT,
  hasSameThreadSelection,
  shouldPreserveThreadSelectionSessionIds,
  type ChatThreadKind,
  type CliAgent,
  type ThreadSelectionLike,
} from "@codesymphony/shared-types";
import type { RuntimeDeps } from "../../types.js";
import { resolveCodexCliProviderOverride } from "../../codex/config.js";
import type { ActiveModelProvider } from "./chatService.types.js";

export type ThreadSelectionInput = {
  agent?: CliAgent | null;
  model?: string | null;
  modelProviderId?: string | null;
  preferActiveProvider?: boolean;
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
  return (BUILTIN_CHAT_MODELS_BY_AGENT[agent] as readonly string[]).includes(model);
}

function resolveDefaultModelForAgent(agent: CliAgent): string {
  if (agent === "codex") {
    const codexCliModel = resolveCodexCliProviderOverride()?.model?.trim();
    if (codexCliModel) {
      return codexCliModel;
    }
  }

  return DEFAULT_CHAT_MODEL_BY_AGENT[agent];
}

function resolveBuiltinModelSelection(agent: CliAgent, model: string): string {
  if (agent === "codex" && isBuiltinModelForAgent(agent, model)) {
    const codexCliModel = resolveCodexCliProviderOverride()?.model?.trim();
    if (codexCliModel) {
      return codexCliModel;
    }
  }

  return model;
}

function toActiveModelProvider(provider: {
  id: string;
  agent: CliAgent;
  apiKey: string | null;
  baseUrl: string | null;
  name: string;
  modelId: string;
}): ActiveModelProvider {
  return {
    id: provider.id,
    agent: provider.agent,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    name: provider.name,
    modelId: provider.modelId,
  };
}

export async function resolvePersistedThreadProvider(
  deps: RuntimeDeps,
  thread: { modelProviderId?: string | null },
): Promise<ActiveModelProvider | null> {
  const providerId = normalizeOptionalModelId(thread.modelProviderId);
  if (!providerId) {
    return null;
  }

  const provider = await deps.modelProviderService.getProviderById(providerId);
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

  if (requestedProviderId) {
    const provider = await deps.modelProviderService.getProviderById(requestedProviderId);
    if (!provider) {
      throw new Error("Selected model provider not found");
    }
    if (provider.agent === "cursor") {
      throw new Error("Cursor does not support custom model providers");
    }
    if (provider.agent !== agent) {
      throw new Error(`Selected model provider belongs to ${provider.agent}, not ${agent}`);
    }

    return {
      agent,
      model: provider.modelId,
      modelProviderId: provider.id,
      provider: toActiveModelProvider(provider),
    };
  }

  const explicitModel = normalizeOptionalModelId(input.model);
  if (explicitModel) {
    return {
      agent,
      model: resolveBuiltinModelSelection(agent, explicitModel),
      modelProviderId: null,
      provider: null,
    };
  }

  if (input.preferActiveProvider) {
    const activeProvider = await deps.modelProviderService.getActiveProvider(agent);
    if (activeProvider) {
      return {
        agent,
        model: activeProvider.modelId,
        modelProviderId: activeProvider.id,
        provider: toActiveModelProvider(activeProvider),
      };
    }
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

    if (!shouldPreserveThreadSelectionSessionIds({
      threadKind: params.thread.kind,
      currentAgent: params.thread.agent,
      currentModelProviderId: params.thread.modelProviderId,
      nextAgent: selection.agent,
      nextModelProviderId: selection.modelProviderId,
    })) {
      throw new Error("Cannot change provider source after the thread has messages");
    }
  }

  return {
    selection,
    selectionChanged,
    selectionUpdate: buildSelectionUpdate(selection, {
      resetSessionIds: params.messageCount === 0,
    }),
  };
}
