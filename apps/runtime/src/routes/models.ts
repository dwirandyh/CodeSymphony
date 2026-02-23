import type { FastifyInstance } from "fastify";
import {
  CreateModelProviderInputSchema,
  TestModelProviderInputSchema,
  UpdateModelProviderInputSchema,
} from "@codesymphony/shared-types";

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
    const { baseUrl, apiKey, modelId } = input;

    try {
      const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "Hi" }],
        }),
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
