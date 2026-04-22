import type { FastifyInstance } from "fastify";
import {
  type CliAgent,
  CreateModelProviderInputSchema,
  TestModelProviderInputSchema,
  UpdateModelProviderInputSchema,
} from "@codesymphony/shared-types";

function normalizeProviderTestUrl(baseUrl: string, agent: CliAgent): string {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");

  if (agent === "codex") {
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

export async function registerModelRoutes(app: FastifyInstance) {
  app.get("/model-providers", async () => {
    const providers = await app.modelProviderService.listProviders();
    return { data: providers };
  });

  app.post("/model-providers", async (request) => {
    const input = CreateModelProviderInputSchema.parse(request.body);
    const provider = await app.modelProviderService.createProvider(input);
    return { data: provider };
  });

  app.patch("/model-providers/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = UpdateModelProviderInputSchema.parse(request.body);
    const provider = await app.modelProviderService.updateProvider(id, input);
    return { data: provider };
  });

  app.delete("/model-providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await app.modelProviderService.deleteProvider(id);
    return reply.code(204).send();
  });

  app.post("/model-providers/:id/activate", async (request) => {
    const { id } = request.params as { id: string };
    const provider = await app.modelProviderService.activateProvider(id);
    return { data: provider };
  });

  app.post("/model-providers/deactivate", async (_request, reply) => {
    await app.modelProviderService.deactivateAll();
    return reply.code(204).send();
  });

  app.post("/model-providers/test", async (request) => {
    const input = TestModelProviderInputSchema.parse(request.body);
    const { agent, baseUrl, apiKey, modelId } = input;

    try {
      const url = normalizeProviderTestUrl(baseUrl, agent);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(agent === "codex"
            ? {
                Authorization: `Bearer ${apiKey}`,
              }
            : {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              }),
        },
        body: JSON.stringify(
          agent === "codex"
            ? {
                model: modelId,
                input: "Hi",
                max_output_tokens: 1,
              }
            : {
                model: modelId,
                max_tokens: 1,
                messages: [{ role: "user", content: "Hi" }],
              },
        ),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = body.length > 0 ? body.slice(0, 300) : `HTTP ${response.status}`;
        return { data: { success: false, error: `Provider returned ${response.status}: ${detail}` } };
      }

      return { data: { success: true } };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { data: { success: false, error: message } };
    }
  });
}
