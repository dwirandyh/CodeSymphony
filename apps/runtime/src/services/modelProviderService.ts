import type { PrismaClient } from "@prisma/client";
import type { CreateModelProviderInput, UpdateModelProviderInput, ModelProvider } from "@codesymphony/shared-types";

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 11) return "••••";
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

function mapProvider(provider: {
  id: string;
  name: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ModelProvider {
  return {
    id: provider.id,
    name: provider.name,
    modelId: provider.modelId,
    baseUrl: provider.baseUrl,
    apiKeyMasked: maskApiKey(provider.apiKey),
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
          name: input.name,
          modelId: input.modelId,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
        },
      });
      return mapProvider(provider);
    },

    async updateProvider(id: string, input: UpdateModelProviderInput): Promise<ModelProvider> {
      const provider = await prisma.modelProvider.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        },
      });
      return mapProvider(provider);
    },

    async deleteProvider(id: string): Promise<void> {
      await prisma.modelProvider.delete({ where: { id } });
    },

    async activateProvider(id: string): Promise<ModelProvider> {
      return await prisma.$transaction(async (tx) => {
        await tx.modelProvider.updateMany({
          where: { isActive: true },
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

    async getActiveProvider(): Promise<{ apiKey: string; baseUrl: string; name: string; modelId: string } | null> {
      const provider = await prisma.modelProvider.findFirst({
        where: { isActive: true },
      });
      if (!provider) return null;
      return { apiKey: provider.apiKey, baseUrl: provider.baseUrl, name: provider.name, modelId: provider.modelId };
    },
  };
}
