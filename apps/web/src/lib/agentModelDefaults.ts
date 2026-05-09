import {
  DEFAULT_CHAT_MODEL_BY_AGENT,
  type CliAgent,
  type CodexModelCatalogEntry,
} from "@codesymphony/shared-types";

export const DEFAULT_CODEX_MODEL_FALLBACK = "gpt-5.4";

export const FALLBACK_CODEX_MODELS: readonly CodexModelCatalogEntry[] = [
  {
    id: DEFAULT_CODEX_MODEL_FALLBACK,
    name: "GPT-5.4",
    description: "Local emergency fallback when the Codex catalog is unavailable.",
    hidden: false,
    isDefault: true,
  },
];

export function resolveAgentDefaultModel(agent: CliAgent): string {
  return agent === "codex"
    ? DEFAULT_CODEX_MODEL_FALLBACK
    : DEFAULT_CHAT_MODEL_BY_AGENT[agent];
}
