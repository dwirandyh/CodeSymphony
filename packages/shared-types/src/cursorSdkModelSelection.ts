import { applyCursorModelOptions, getCursorBaseModelName, isCursorComposerModel, parseCursorModelMetadata } from "./modelCapabilities.js";

export type CursorSdkModelParameterValue = {
  id: string;
  value: string;
};

export type CursorSdkModelCatalogItem = {
  id: string;
  displayName?: string;
  parameters?: Array<{
    id: string;
    values: Array<{ value: string }>;
  }>;
  variants?: Array<{
    params: CursorSdkModelParameterValue[];
    isDefault?: boolean;
  }>;
};

export type CursorSdkModelSelection = {
  id: string;
  params?: CursorSdkModelParameterValue[];
};

function supportsParam(
  catalogModel: CursorSdkModelCatalogItem | undefined,
  paramId: string,
  value: string,
): boolean {
  return catalogModel?.parameters?.some((parameter) => (
    parameter.id === paramId
      && parameter.values.some((candidate) => candidate.value === value)
  )) ?? false;
}

function pushParam(
  params: CursorSdkModelParameterValue[],
  catalogModel: CursorSdkModelCatalogItem | undefined,
  paramId: string,
  value: string | null,
): void {
  if (!value || !supportsParam(catalogModel, paramId, value)) {
    return;
  }

  const existing = params.find((param) => param.id === paramId);
  if (existing) {
    existing.value = value;
    return;
  }

  params.push({ id: paramId, value });
}

function resolveComposerFastValue(params: {
  model: string;
  modelOptions?: readonly { id: string; value: unknown }[];
}): string | null {
  // Cursor's catalog normalizes the composer fast variant to the bare model id
  // (e.g. `composer-2.5`), so the bare id already _is_ the fast variant.
  // Sending an explicit `fast=true` param to setSessionModel is rejected with
  // "Invalid params". Only emit `fast=false` to switch to the thinking variant.
  const option = params.modelOptions?.find((candidate) => candidate.id === "fastMode");
  if (option?.value === false) {
    return "false";
  }
  if (option?.value === true) {
    return null;
  }

  const metadataFast = parseCursorModelMetadata(params.model).get("fast");
  return metadataFast === "false" ? "false" : null;
}

export function resolveCursorSdkModelSelection(params: {
  model: string;
  modelOptions?: readonly { id: string; value: unknown }[];
  catalog?: readonly CursorSdkModelCatalogItem[];
}): CursorSdkModelSelection {
  const modelWithOptions = params.modelOptions?.length
    ? applyCursorModelOptions(params.model, params.modelOptions)
    : params.model;
  const id = getCursorBaseModelName(modelWithOptions);
  const catalogModel = params.catalog?.find((candidate) => candidate.id === id);
  const metadata = parseCursorModelMetadata(modelWithOptions);
  const sdkParams: CursorSdkModelParameterValue[] = [];

  if (isCursorComposerModel(modelWithOptions)) {
    pushParam(sdkParams, catalogModel, "fast", resolveComposerFastValue({
      model: params.model,
      modelOptions: params.modelOptions,
    }));
  }

  pushParam(sdkParams, catalogModel, "thinking", metadata.get("reasoning") ?? metadata.get("effort") ?? null);

  if (sdkParams.length === 0) {
    return { id };
  }

  return {
    id,
    params: sdkParams,
  };
}
