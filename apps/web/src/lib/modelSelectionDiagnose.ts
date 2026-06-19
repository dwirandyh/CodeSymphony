import {
  buildThreadModelOptionsKey,
  type CliAgent,
  type ProviderOptionSelection,
} from "@codesymphony/shared-types";
import { debugLog } from "./debugLog";

/** Always-on trail for Cursor model / effort sync bugs (included in issue reports). */
export function logModelSelectionDiagnose(
  message: string,
  data: Record<string, unknown>,
  options?: {
    threadId?: string | null;
    worktreeId?: string | null;
  },
) {
  debugLog("model.selection", message, data, {
    threadId: options?.threadId ?? null,
    worktreeId: options?.worktreeId ?? null,
    force: true,
  });
}

export function modelSelectionDiagnosePayload(input: {
  agent: CliAgent;
  model: string;
  modelProviderId?: string | null;
  modelOptions?: readonly ProviderOptionSelection[];
  modelOptionsPerModel?: Record<string, readonly ProviderOptionSelection[]>;
  source: string;
}): Record<string, unknown> {
  const modelKey = buildThreadModelOptionsKey({
    agent: input.agent,
    model: input.model,
    modelProviderId: input.modelProviderId ?? null,
  });
  const perModel = input.modelOptionsPerModel?.[modelKey];
  return {
    source: input.source,
    agent: input.agent,
    model: input.model,
    modelProviderId: input.modelProviderId ?? null,
    modelKey,
    modelOptions: input.modelOptions ?? null,
    modelOptionsPerModelEntry: perModel ?? null,
  };
}