import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  DEFAULT_CHAT_MODEL_BY_AGENT,
  type CliAgent,
} from "@codesymphony/shared-types";

export const AGENT_DEFAULTS_STORAGE_KEY = "codesymphony:workspace:agent-defaults";

export type AgentDefaultSelection = {
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
};

export type AgentDefaults = {
  newChat: AgentDefaultSelection;
  commit: AgentDefaultSelection;
  pullRequest: AgentDefaultSelection;
};

const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  newChat: {
    agent: "claude",
    model: DEFAULT_CHAT_MODEL_BY_AGENT.claude,
    modelProviderId: null,
  },
  commit: {
    agent: "claude",
    model: DEFAULT_CHAT_MODEL_BY_AGENT.claude,
    modelProviderId: null,
  },
  pullRequest: {
    agent: "claude",
    model: DEFAULT_CHAT_MODEL_BY_AGENT.claude,
    modelProviderId: null,
  },
};

function normalizeSelection(input: unknown, fallback: AgentDefaultSelection): AgentDefaultSelection {
  if (!input || typeof input !== "object") {
    return fallback;
  }

  const record = input as Partial<AgentDefaultSelection>;
  const agent = record.agent;
  const model = record.model;
  const modelProviderId = record.modelProviderId;

  if (
    agent !== "claude"
    && agent !== "codex"
    && agent !== "cursor"
    && agent !== "opencode"
  ) {
    return fallback;
  }

  if (typeof model !== "string" || model.trim().length === 0) {
    return {
      agent,
      model: DEFAULT_CHAT_MODEL_BY_AGENT[agent],
      modelProviderId: null,
    };
  }

  const normalizedModel = model.trim();
  const builtinModels = BUILTIN_CHAT_MODELS_BY_AGENT[agent] as readonly string[];
  const normalizedProviderId = typeof modelProviderId === "string" && modelProviderId.trim().length > 0
    ? modelProviderId.trim()
    : null;

  if (normalizedProviderId !== null || builtinModels.includes(normalizedModel)) {
    return {
      agent,
      model: normalizedModel,
      modelProviderId: normalizedProviderId,
    };
  }

  return {
    agent,
    model: DEFAULT_CHAT_MODEL_BY_AGENT[agent],
    modelProviderId: null,
  };
}

export function normalizeAgentDefaults(input: unknown): AgentDefaults {
  if (!input || typeof input !== "object") {
    return DEFAULT_AGENT_DEFAULTS;
  }

  const record = input as Partial<Record<keyof AgentDefaults, unknown>>;

  return {
    newChat: normalizeSelection(record.newChat, DEFAULT_AGENT_DEFAULTS.newChat),
    commit: normalizeSelection(record.commit, DEFAULT_AGENT_DEFAULTS.commit),
    pullRequest: normalizeSelection(record.pullRequest, DEFAULT_AGENT_DEFAULTS.pullRequest),
  };
}

export function loadAgentDefaults(): AgentDefaults {
  if (typeof window === "undefined") {
    return DEFAULT_AGENT_DEFAULTS;
  }

  try {
    const raw = window.localStorage.getItem(AGENT_DEFAULTS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_AGENT_DEFAULTS;
    }

    return normalizeAgentDefaults(JSON.parse(raw));
  } catch {
    return DEFAULT_AGENT_DEFAULTS;
  }
}

export function saveAgentDefaults(value: AgentDefaults): AgentDefaults {
  const normalized = normalizeAgentDefaults(value);
  if (typeof window === "undefined") {
    return normalized;
  }

  try {
    window.localStorage.setItem(AGENT_DEFAULTS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures and keep the in-memory selection.
  }

  return normalized;
}
