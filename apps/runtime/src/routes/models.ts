import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  type ModelCapabilities,
  ClaudeModelCatalogSchema,
  CodexModelCatalogSchema,
  CreateModelProviderInputSchema,
  CreateModelProviderModelInputSchema,
  CursorModelCatalogSchema,
  OpencodeModelCatalogSchema,
  TestModelProviderInputSchema,
  UpdateModelProviderInputSchema,
  type ModelProviderCompatibility,
  normalizeCursorCatalogModelId,
} from "@codesymphony/shared-types";
import * as claudeModelCatalog from "../claude/modelCatalog.js";
import { getClaudeModelCapabilities } from "../claude/modelCapabilities.js";
import { getCodexModelCapabilities } from "../codex/modelCapabilities.js";
import { getCursorModelCapabilities } from "../cursor/modelCapabilities.js";
import { getOpencodeModelCapabilities } from "../opencode/modelCapabilities.js";
import * as codexSessionRunner from "../codex/sessionRunner.js";
import * as cursorSessionRunner from "../cursor/sessionRunner.js";
import * as opencodeModelCatalog from "../opencode/modelCatalog.js";
import { createPersistentExpiringCache } from "../services/persistentExpiringCache.js";

const MODEL_CATALOG_CACHE_TTL_MS = 3 * 24 * 60 * 60_000;

function resolveModelCatalogCacheDir(): string {
  const configuredDir = process.env.CODESYMPHONY_MODEL_CATALOG_CACHE_DIR?.trim();
  if (configuredDir) {
    return path.resolve(configuredDir);
  }

  return path.join(os.homedir(), ".codesymphony", "cache", "model-catalogs");
}

function resolveModelCatalogCachePath(catalogId: string): string {
  return path.join(resolveModelCatalogCacheDir(), `${catalogId}.json`);
}

function normalizeProviderTestUrl(baseUrl: string, compatibility: ModelProviderCompatibility): string {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");

  if (compatibility === "openai") {
    return trimmedBaseUrl.endsWith("/responses")
      ? trimmedBaseUrl
      : `${trimmedBaseUrl}/responses`;
  }

  if (trimmedBaseUrl.endsWith("/v1/messages")) {
    return trimmedBaseUrl;
  }

  return trimmedBaseUrl.endsWith("/v1")
    ? `${trimmedBaseUrl}/messages`
    : `${trimmedBaseUrl}/v1/messages`;
}

function normalizeOpenAiCompatibilityUrl(baseUrl: string, endpoint: "responses" | "chat/completions"): string {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");
  const withoutKnownEndpoint = trimmedBaseUrl
    .replace(/\/responses$/, "")
    .replace(/\/chat\/completions$/, "");
  return `${withoutKnownEndpoint}/${endpoint}`;
}

async function readErrorDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return body.length > 0 ? body.slice(0, 300) : `HTTP ${response.status}`;
}

async function testOpenAiCompatibleProvider(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<{ success: boolean; error?: string }> {
  const headers = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json",
  };
  const responsesUrl = normalizeOpenAiCompatibilityUrl(params.baseUrl, "responses");
  const responsesResponse = await fetch(responsesUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: params.modelId,
      input: "Hi",
      max_output_tokens: 1,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (responsesResponse.ok) {
    return { success: true };
  }

  const responsesDetail = await readErrorDetail(responsesResponse);
  const shouldProbeChatCompletions =
    responsesResponse.status === 404
    || responsesResponse.status === 405
    || responsesResponse.status === 501;
  if (!shouldProbeChatCompletions) {
    return {
      success: false,
      error: `Provider returned ${responsesResponse.status}: ${responsesDetail}`,
    };
  }

  const chatCompletionsUrl = normalizeOpenAiCompatibilityUrl(params.baseUrl, "chat/completions");
  const chatCompletionsResponse = await fetch(chatCompletionsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: params.modelId,
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (chatCompletionsResponse.ok) {
    return {
      success: false,
      error: "This endpoint supports OpenAI Chat Completions, but Codex requires the OpenAI Responses API. It can work in OpenCode, but not in Codex.",
    };
  }

  const chatCompletionsDetail = await readErrorDetail(chatCompletionsResponse);
  const chatCompletionsLooksSupported =
    chatCompletionsResponse.status !== 404
    && chatCompletionsResponse.status !== 405
    && chatCompletionsResponse.status !== 501;
  if (chatCompletionsLooksSupported) {
    return {
      success: false,
      error: `This endpoint appears to support OpenAI Chat Completions but not the Responses API. Chat Completions returned ${chatCompletionsResponse.status}: ${chatCompletionsDetail}. It can work in OpenCode, but not in Codex.`,
    };
  }

  return {
    success: false,
    error: `Provider returned ${responsesResponse.status}: ${responsesDetail}`,
  };
}

export async function registerModelRoutes(app: FastifyInstance) {
  const claudeModelCatalogCache = createPersistentExpiringCache({
    ttlMs: MODEL_CATALOG_CACHE_TTL_MS,
    storagePath: resolveModelCatalogCachePath("claude"),
    load: async () => claudeModelCatalog.listClaudeModels({
      cwd: process.cwd(),
    }),
    validate: (candidate) => ClaudeModelCatalogSchema.parse({
      models: candidate,
      fetchedAt: "1970-01-01T00:00:00.000Z",
    }).models,
  });
  const codexModelCatalogCache = createPersistentExpiringCache({
    ttlMs: MODEL_CATALOG_CACHE_TTL_MS,
    storagePath: resolveModelCatalogCachePath("codex"),
    load: async () => codexSessionRunner.listCodexModels({
      cwd: process.cwd(),
    }),
    validate: (candidate) => CodexModelCatalogSchema.parse({
      models: candidate,
      fetchedAt: "1970-01-01T00:00:00.000Z",
    }).models,
  });
  const cursorModelCatalogCache = createPersistentExpiringCache({
    ttlMs: MODEL_CATALOG_CACHE_TTL_MS,
    storagePath: resolveModelCatalogCachePath("cursor"),
    load: async () => cursorSessionRunner.listCursorModels({
      cwd: process.cwd(),
    }),
    validate: (candidate) => CursorModelCatalogSchema.parse({
      models: candidate.map((entry: { id: string; name: string }) => ({
        ...entry,
        id: normalizeCursorCatalogModelId(entry.id),
      })),
      fetchedAt: "1970-01-01T00:00:00.000Z",
    }).models,
  });
  const opencodeModelCatalogCache = createPersistentExpiringCache({
    ttlMs: MODEL_CATALOG_CACHE_TTL_MS,
    storagePath: resolveModelCatalogCachePath("opencode"),
    load: async () => opencodeModelCatalog.listOpencodeModels(),
    validate: (candidate) => OpencodeModelCatalogSchema.parse({
      models: candidate,
      fetchedAt: "1970-01-01T00:00:00.000Z",
    }).models,
  });

  app.get("/claude/models", async (_request, reply) => {
    try {
      const snapshot = await claudeModelCatalogCache.get();
      return {
        data: ClaudeModelCatalogSchema.parse({
          models: snapshot.value,
          fetchedAt: snapshot.fetchedAt,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list Claude models";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/codex/models", async (_request, reply) => {
    try {
      const snapshot = await codexModelCatalogCache.get();
      return {
        data: CodexModelCatalogSchema.parse({
          models: snapshot.value,
          fetchedAt: snapshot.fetchedAt,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list Codex models";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/cursor/models", async (_request, reply) => {
    try {
      const snapshot = await cursorModelCatalogCache.get();
      return {
        data: CursorModelCatalogSchema.parse({
          models: snapshot.value,
          fetchedAt: snapshot.fetchedAt,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list Cursor models";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/opencode/models", async (_request, reply) => {
    try {
      const snapshot = await opencodeModelCatalogCache.get();
      return {
        data: OpencodeModelCatalogSchema.parse({
          models: snapshot.value,
          fetchedAt: snapshot.fetchedAt,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list OpenCode models";
      return reply.code(500).send({ error: message });
    }
  });

  app.get<{ Querystring: { agent?: string; model?: string } }>("/model-capabilities", async (request) => {
    const agent = request.query.agent ?? "claude";
    const model = request.query.model;
    let capabilities: ModelCapabilities;
    switch (agent) {
      case "codex":
        capabilities = getCodexModelCapabilities();
        break;
      case "cursor":
        capabilities = getCursorModelCapabilities(model);
        break;
      case "opencode":
        capabilities = getOpencodeModelCapabilities();
        break;
      default:
        capabilities = getClaudeModelCapabilities();
        break;
    }
    return { data: capabilities };
  });

  app.get("/model-providers", async () => {
    const providers = await app.modelProviderService.listProviders();
    return { data: providers };
  });

  app.post("/model-providers", async (request, reply) => {
    try {
      const input = CreateModelProviderInputSchema.parse(request.body);
      const provider = await app.modelProviderService.createProvider(input);
      return { data: provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create model provider";
      return reply.code(400).send({ error: message });
    }
  });

  app.patch("/model-providers/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = UpdateModelProviderInputSchema.parse(request.body);
      const provider = await app.modelProviderService.updateProvider(id, input);
      return { data: provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update model provider";
      return reply.code(400).send({ error: message });
    }
  });

  app.delete("/model-providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await app.modelProviderService.deleteProvider(id);
    return reply.code(204).send();
  });

  app.post("/model-providers/:id/models", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = CreateModelProviderModelInputSchema.parse(request.body);
      const provider = await app.modelProviderService.createModel(id, input);
      return { data: provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create model provider model";
      return reply.code(400).send({ error: message });
    }
  });

  app.delete("/model-provider-models/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await app.modelProviderService.deleteModel(id);
    return reply.code(204).send();
  });

  app.post("/model-providers/test", async (request) => {
    const input = TestModelProviderInputSchema.parse(request.body);
    let compatibility: ModelProviderCompatibility;
    let baseUrl: string;
    let apiKey: string;
    const { modelId } = input;

    if ("providerId" in input) {
      try {
        const provider = await app.modelProviderService.resolveProviderSelection(input.providerId, modelId);
        if (!provider) {
          return { data: { success: false, error: "Selected model provider not found" } };
        }
        compatibility = provider.compatibility;
        baseUrl = provider.baseUrl ?? "";
        apiKey = provider.apiKey ?? "";
      } catch (error) {
        const message = error instanceof Error ? error.message : "Selected provider model not found";
        return { data: { success: false, error: message } };
      }
    } else {
      compatibility = input.compatibility;
      baseUrl = input.baseUrl;
      apiKey = input.apiKey;
    }

    try {
      if (compatibility === "openai") {
        return {
          data: await testOpenAiCompatibleProvider({
            baseUrl,
            apiKey,
            modelId,
          }),
        };
      }

      const url = normalizeProviderTestUrl(baseUrl, compatibility);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(
          {
            model: modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "Hi" }],
          },
        ),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        return { data: { success: false, error: `Provider returned ${response.status}: ${detail}` } };
      }

      return { data: { success: true } };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { data: { success: false, error: message } };
    }
  });
}
