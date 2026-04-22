import type { PrismaClient } from "@prisma/client";
import type { CliAgent, CreateModelProviderInput, UpdateModelProviderInput, ModelProvider } from "@codesymphony/shared-types";

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 11) return "••••";
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

function normalizeOptionalSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function mapProvider(provider: {
  id: string;
  agent: CliAgent;
  name: string;
  modelId: string;
  baseUrl: string | null;
  apiKey: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ModelProvider {
  return {
    id: provider.id,
    agent: provider.agent,
    name: provider.name,
    modelId: provider.modelId,
    baseUrl: provider.baseUrl,
    apiKeyMasked: provider.apiKey ? maskApiKey(provider.apiKey) : "",
    isActive: provider.isActive,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

export function createModelProviderService(prisma: PrismaClient) {
  return {
    async listProviders(): Promise<ModelProvider[]> {
      const providers = await prisma.modelProvider.findMany({
        orderBy: { createdAt: "asc" },
      });
      return providers.map(mapProvider);
    },

    async createProvider(input: CreateModelProviderInput): Promise<ModelProvider> {
      const provider = await prisma.modelProvider.create({
        data: {
          agent: input.agent ?? "claude",
          name: input.name,
          modelId: input.modelId,
          baseUrl: normalizeOptionalSecret(input.baseUrl),
          apiKey: normalizeOptionalSecret(input.apiKey),
        },
      });
      return mapProvider(provider);
    },

    async updateProvider(id: string, input: UpdateModelProviderInput): Promise<ModelProvider> {
      const provider = await prisma.modelProvider.update({
        where: { id },
        data: {
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: normalizeOptionalSecret(input.baseUrl) } : {}),
          ...(input.apiKey !== undefined ? { apiKey: normalizeOptionalSecret(input.apiKey) } : {}),
        },
      });
      return mapProvider(provider);
    },

    async deleteProvider(id: string): Promise<void> {
      await prisma.modelProvider.delete({ where: { id } });
    },

    async activateProvider(id: string): Promise<ModelProvider> {
      return await prisma.$transaction(async (tx) => {
        const selected = await tx.modelProvider.findUniqueOrThrow({
          where: { id },
          select: { agent: true },
        });
        await tx.modelProvider.updateMany({
          where: {
            isActive: true,
            agent: selected.agent,
          },
          data: { isActive: false },
        });
        const provider = await tx.modelProvider.update({
          where: { id },
          data: { isActive: true },
        });
        return mapProvider(provider);
      });
    },

    async deactivateAll(): Promise<void> {
      await prisma.modelProvider.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
    },

    async getActiveProvider(agent: CliAgent = "claude"): Promise<{
      id: string;
      agent: CliAgent;
      apiKey: string | null;
      baseUrl: string | null;
      name: string;
      modelId: string;
    } | null> {
      const provider = await prisma.modelProvider.findFirst({
        where: {
          isActive: true,
          agent,
        },
      });
      if (!provider) return null;
      return {
        id: provider.id,
        agent: provider.agent,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        name: provider.name,
        modelId: provider.modelId,
      };
    },

    async getProviderById(id: string): Promise<{
      id: string;
      agent: CliAgent;
      apiKey: string | null;
      baseUrl: string | null;
      name: string;
      modelId: string;
      isActive: boolean;
    } | null> {
      const provider = await prisma.modelProvider.findUnique({
        where: { id },
      });
      if (!provider) {
        return null;
      }
      return {
        id: provider.id,
        agent: provider.agent,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        name: provider.name,
        modelId: provider.modelId,
        isActive: provider.isActive,
      };
    },
  };
}
