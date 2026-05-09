import { DEFAULT_CHAT_MODEL_BY_AGENT, type CliAgent } from "@codesymphony/shared-types";
import { resolveCodexCliProviderOverride } from "./codex/config.js";

export const DEFAULT_CODEX_MODEL_FALLBACK = "gpt-5.4";

export function resolveCodexDefaultModel(): string {
  const codexCliModel = resolveCodexCliProviderOverride()?.model?.trim();
  return codexCliModel && codexCliModel.length > 0
    ? codexCliModel
    : DEFAULT_CODEX_MODEL_FALLBACK;
}

export function resolveAgentDefaultModel(agent: CliAgent): string {
  return agent === "codex"
    ? resolveCodexDefaultModel()
    : DEFAULT_CHAT_MODEL_BY_AGENT[agent];
}

export function isBuiltinCodexModelSelection(model: string): boolean {
  return model.trim().length > 0;
}

export function resolveBuiltinCodexModelSelection(model: string): string {
  const normalizedModel = model.trim();
  return normalizedModel.length > 0
    ? normalizedModel
    : resolveCodexDefaultModel();
}
