import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpencodeModelCatalogEntry } from "@codesymphony/shared-types";
import { ensureConfiguredOpencodeBinaryOnPath, resolveOpencodeBinaryPath } from "./binary.js";

const execFileAsync = promisify(execFile);

const OPENCODE_MODELS_TIMEOUT_MS = 20_000;
const OPENCODE_MODELS_CACHE_TTL_MS = 5 * 60_000;
const OPENCODE_MODELS_MAX_BUFFER_BYTES = 1024 * 1024;

type OpencodeVerboseModelRecord = {
  id?: string;
  name?: string;
  providerID?: string;
};

let cachedModels: OpencodeModelCatalogEntry[] | null = null;
let cachedAtMs = 0;

function resolveOpencodeModelProviderId(modelId: string, providerId?: string): string {
  const normalizedProviderId = providerId?.trim();
  if (normalizedProviderId) {
    return normalizedProviderId;
  }

  const [derivedProviderId] = modelId.split("/", 1);
  return derivedProviderId?.trim() || "opencode";
}

function buildOpencodeModelCatalogEntry(
  modelId: string,
  metadata?: OpencodeVerboseModelRecord,
): OpencodeModelCatalogEntry {
  const normalizedModelId = modelId.trim();
  const providerId = resolveOpencodeModelProviderId(normalizedModelId, metadata?.providerID);
  const shortModelId = metadata?.id?.trim() || normalizedModelId;
  const fullModelId = normalizedModelId.includes("/")
    ? normalizedModelId
    : `${providerId}/${shortModelId}`;

  return {
    id: fullModelId,
    name: metadata?.name?.trim() || fullModelId,
    providerId,
  };
}

function readJsonBlock(lines: string[], startIndex: number): { endIndex: number; text: string } | null {
  let braceDepth = 0;
  let started = false;
  const buffer: string[] = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!;
    buffer.push(line);

    for (const character of line) {
      if (character === "{") {
        braceDepth += 1;
        started = true;
      } else if (character === "}") {
        braceDepth -= 1;
      }
    }

    if (started && braceDepth === 0) {
      return {
        endIndex: index,
        text: buffer.join("\n"),
      };
    }
  }

  return null;
}

export function parseOpencodeModelCatalog(stdout: string): OpencodeModelCatalogEntry[] {
  const seen = new Set<string>();
  const models: OpencodeModelCatalogEntry[] = [];
  const lines = stdout.split(/\r?\n/);

  function pushModel(entry: OpencodeModelCatalogEntry) {
    if (seen.has(entry.id)) {
      return;
    }

    seen.add(entry.id);
    models.push(entry);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index]?.trim();
    if (!candidate) {
      continue;
    }

    const nextLine = lines[index + 1]?.trim();
    if (nextLine?.startsWith("{")) {
      const jsonBlock = readJsonBlock(lines, index + 1);
      if (jsonBlock) {
        try {
          const metadata = JSON.parse(jsonBlock.text) as OpencodeVerboseModelRecord;
          pushModel(buildOpencodeModelCatalogEntry(candidate, metadata));
          index = jsonBlock.endIndex;
          continue;
        } catch {
          pushModel(buildOpencodeModelCatalogEntry(candidate));
          index = jsonBlock.endIndex;
          continue;
        }
      }
    }

    pushModel(buildOpencodeModelCatalogEntry(candidate));
  }

  return models;
}

export async function listOpencodeModels(
  options?: { refresh?: boolean },
): Promise<OpencodeModelCatalogEntry[]> {
  const refresh = options?.refresh === true;
  const cached = cachedModels;
  const cacheIsFresh = cached !== null && Date.now() - cachedAtMs < OPENCODE_MODELS_CACHE_TTL_MS;
  if (!refresh && cacheIsFresh && cached) {
    return cached;
  }

  ensureConfiguredOpencodeBinaryOnPath();

  const args = ["models", "--verbose"];
  if (refresh) {
    args.push("--refresh");
  }

  const { stdout } = await execFileAsync(resolveOpencodeBinaryPath(), args, {
    env: process.env,
    timeout: OPENCODE_MODELS_TIMEOUT_MS,
    maxBuffer: OPENCODE_MODELS_MAX_BUFFER_BYTES,
  });

  const models = parseOpencodeModelCatalog(stdout);
  if (models.length === 0) {
    throw new Error("OpenCode CLI returned an empty model catalog.");
  }

  cachedModels = models;
  cachedAtMs = Date.now();
  return models;
}
