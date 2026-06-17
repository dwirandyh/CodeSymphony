import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cursor, type SDKModel } from "@cursor/sdk";
import { normalizeCursorCatalogModelId, type SlashCommand } from "@codesymphony/shared-types";

const SKILL_SCAN_MAX_DEPTH = 6;

function modelParamSuffix(params: Array<{ id: string; value: string }> | undefined): string {
  if (!params || params.length === 0) {
    return "";
  }

  return `[${params.map((param) => `${param.id}=${param.value}`).join(",")}]`;
}

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

function expandSdkModel(model: SDKModel): Array<{ id: string; name: string }> {
  if (!model.variants || model.variants.length === 0) {
    return [{
      id: normalizeCursorCatalogModelId(model.id),
      name: model.displayName.trim() || model.id,
    }];
  }

  return model.variants.map((variant) => ({
    id: normalizeCursorCatalogModelId(`${model.id}${modelParamSuffix(variant.params)}`),
    name: modelVariantName(model, variant.displayName),
  }));
}

export async function listCursorSdkModels(params: {
  apiKey?: string;
} = {}): Promise<Array<{ id: string; name: string }>> {
  const models = await listCursorSdkModelCatalog(params);
  return models.flatMap(expandSdkModel);
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
