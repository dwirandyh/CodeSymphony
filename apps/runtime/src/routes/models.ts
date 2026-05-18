import type { FastifyInstance } from "fastify";
import {
  CodexModelCatalogSchema,
  CreateModelProviderInputSchema,
  CursorModelCatalogSchema,
  OpencodeModelCatalogSchema,
  TestModelProviderInputSchema,
  UpdateModelProviderInputSchema,
  type ModelProviderCompatibility,
} from "@codesymphony/shared-types";
import * as codexSessionRunner from "../codex/sessionRunner.js";
import * as cursorSessionRunner from "../cursor/sessionRunner.js";
import * as opencodeModelCatalog from "../opencode/modelCatalog.js";

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
  app.get("/codex/models", async (_request, reply) => {
    try {
      const payload = CodexModelCatalogSchema.parse({
        models: await codexSessionRunner.listCodexModels({
          cwd: process.cwd(),
        }),
        fetchedAt: new Date().toISOString(),
      });
      return { data: payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list Codex models";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/cursor/models", async (_request, reply) => {
    try {
      const payload = CursorModelCatalogSchema.parse({
        models: await cursorSessionRunner.listCursorModels({
          cwd: process.cwd(),
        }),
        fetchedAt: new Date().toISOString(),
      });
      return { data: payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list Cursor models";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/opencode/models", async (_request, reply) => {
    try {
      const payload = OpencodeModelCatalogSchema.parse({
        models: await opencodeModelCatalog.listOpencodeModels(),
        fetchedAt: new Date().toISOString(),
      });
      return { data: payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to list OpenCode models";
      return reply.code(500).send({ error: message });
    }
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

  app.post("/model-providers/:id/activate", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const provider = await app.modelProviderService.activateProvider(id);
      return { data: provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to activate model provider";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/model-providers/deactivate", async (_request, reply) => {
    await app.modelProviderService.deactivateAll();
    return reply.code(204).send();
  });

  app.post("/model-providers/test", async (request, reply) => {
    const input = TestModelProviderInputSchema.parse(request.body);
    const { compatibility, baseUrl, apiKey, modelId } = input;

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
