import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cursor, type SDKModel } from "@cursor/sdk";
import {
  dedupeCursorCatalogEntries,
  isCursorComposerModel,
  normalizeCursorCatalogModelId,
  type CursorModelCatalogEntry,
  type SlashCommand,
} from "@codesymphony/shared-types";

const SKILL_SCAN_MAX_DEPTH = 6;

function normalizeComparableDisplayName(value: string): string {
  return value.replace(/\[[^\]]*]/g, "").trim().toLowerCase();
}

export function resolveCursorCatalogDisplayName(
  modelDisplayName: string,
  modelId: string,
  variantDisplayName: string,
): string {
  const baseName = modelDisplayName.trim() || modelId.trim();
  const variantName = variantDisplayName.trim();
  if (!variantName) {
    return baseName;
  }

  const baseComparable = normalizeComparableDisplayName(baseName);
  const variantComparable = normalizeComparableDisplayName(variantName);
  if (variantComparable === baseComparable) {
    return variantName;
  }

  if (
    variantComparable.startsWith(`${baseComparable} `)
    || variantComparable.startsWith(`${baseComparable}-`)
  ) {
    return variantName;
  }

  return `${baseName} ${variantName}`;
}

function modelVariantName(model: SDKModel, variantDisplayName: string): string {
  return resolveCursorCatalogDisplayName(model.displayName, model.id, variantDisplayName);
}

function pickDefaultVariant(model: SDKModel) {
  if (!model.variants || model.variants.length === 0) {
    return null;
  }

  return model.variants.find((variant) => variant.isDefault) ?? model.variants[0]!;
}

function mapSdkParameters(model: SDKModel): CursorModelCatalogEntry["parameters"] {
  if (!model.parameters?.length) {
    return undefined;
  }

  return model.parameters.map((parameter) => ({
    id: parameter.id,
    values: parameter.values.map((value) => value.value),
  }));
}

function variantParamsRecord(
  params: Array<{ id: string; value: string }> | undefined,
): Record<string, string> | undefined {
  if (!params?.length) {
    return undefined;
  }

  return Object.fromEntries(params.map((param) => [param.id, param.value]));
}

export function resolveSdkModelDefaultVariantParams(
  model: SDKModel,
): Record<string, string> | undefined {
  return variantParamsRecord(pickDefaultVariant(model)?.params);
}

function expandSdkModel(model: SDKModel): CursorModelCatalogEntry[] {
  const baseName = model.displayName.trim() || model.id;
  const defaultVariant = pickDefaultVariant(model);
  const parameters = mapSdkParameters(model);

  if (!defaultVariant) {
    return [{
      id: normalizeCursorCatalogModelId(model.id),
      name: baseName,
      ...(parameters ? { parameters } : {}),
    }];
  }

  const name = isCursorComposerModel(model.id)
    ? baseName
    : modelVariantName(model, defaultVariant.displayName);
  const defaultVariantParams = variantParamsRecord(defaultVariant.params);

  return [{
    id: normalizeCursorCatalogModelId(model.id),
    name,
    ...(defaultVariantParams ? { defaultVariantParams } : {}),
    ...(parameters ? { parameters } : {}),
  }];
}

export async function listCursorSdkModels(params: {
  apiKey?: string;
} = {}): Promise<CursorModelCatalogEntry[]> {
  const models = await listCursorSdkModelCatalog(params);
  return dedupeCursorCatalogEntries(models.flatMap(expandSdkModel));
}

export async function listCursorSdkModelCatalog(params: {
  apiKey?: string;
} = {}): Promise<SDKModel[]> {
  return Cursor.models.list(params.apiKey ? { apiKey: params.apiKey } : undefined);
}

async function collectSkillFiles(rootPath: string, depth = 0): Promise<string[]> {
  if (depth > SKILL_SCAN_MAX_DEPTH) {
    return [];
  }

  let rootStats;
  try {
    rootStats = await stat(rootPath);
  } catch {
    return [];
  }

  if (!rootStats.isDirectory()) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(rootPath);
  } catch {
    return [];
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const nextPath = join(rootPath, entry);
    try {
      const nextStats = await stat(nextPath);
      if (nextStats.isDirectory()) {
        return collectSkillFiles(nextPath, depth + 1);
      }
      return entry === "SKILL.md" ? [nextPath] : [];
    } catch {
      return [];
    }
  }));

  return files.flat();
}

function parseFrontMatterValue(content: string, key: string): string | null {
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const body = frontMatterMatch?.[1] ?? content;
  const line = body.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(`${key}:`));
  if (!line) {
    return null;
  }

  return line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
}

async function readSkillCommand(filePath: string): Promise<SlashCommand | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const name = parseFrontMatterValue(content, "name");
  if (!name) {
    return null;
  }

  return {
    name,
    description: parseFrontMatterValue(content, "description") ?? "",
    argumentHint: "",
  };
}

export async function listCursorSdkSlashCommands(params: {
  cwd: string;
}): Promise<SlashCommand[]> {
  const roots = [
    join(params.cwd, ".cursor", "skills"),
    join(homedir(), ".cursor", "skills"),
  ];
  const skillFiles = (await Promise.all(roots.map((root) => collectSkillFiles(root)))).flat();
  const commands = (await Promise.all(skillFiles.map((filePath) => readSkillCommand(filePath))))
    .filter((command): command is SlashCommand => command !== null);
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    byName.set(command.name, command);
  }

  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}
