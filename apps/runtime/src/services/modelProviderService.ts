import type { PrismaClient } from "@prisma/client";
import {
  MODEL_PROVIDER_COMPATIBILITIES_BY_AGENT,
  type CliAgent,
  type CreateModelProviderInput,
  type UpdateModelProviderInput,
  type ModelProvider,
  type ModelProviderCompatibility,
} from "@codesymphony/shared-types";

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
  compatibility: ModelProviderCompatibility;
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
    compatibility: provider.compatibility,
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
          compatibility: input.compatibility,
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
          ...(input.compatibility !== undefined ? { compatibility: input.compatibility } : {}),
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
          select: { compatibility: true },
        });
        await tx.modelProvider.updateMany({
          where: {
            isActive: true,
            compatibility: selected.compatibility,
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
      compatibility: ModelProviderCompatibility;
      apiKey: string | null;
      baseUrl: string | null;
      name: string;
      modelId: string;
    } | null> {
      const compatibilities = MODEL_PROVIDER_COMPATIBILITIES_BY_AGENT[agent];
      if (compatibilities.length === 0) {
        return null;
      }

      const providers = await prisma.modelProvider.findMany({
        where: {
          isActive: true,
          compatibility: {
            in: [...compatibilities],
          },
        },
        orderBy: [
          { createdAt: "asc" },
          { id: "asc" },
        ],
      });

      if (providers.length === 0) {
        return null;
      }

      if (compatibilities.length > 1 && providers.length !== 1) {
        return null;
      }

      const provider = providers[0]!;
      return {
        id: provider.id,
        compatibility: provider.compatibility,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        name: provider.name,
        modelId: provider.modelId,
      };
    },

    async getProviderById(id: string): Promise<{
      id: string;
      compatibility: ModelProviderCompatibility;
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
        compatibility: provider.compatibility,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        name: provider.name,
        modelId: provider.modelId,
        isActive: provider.isActive,
      };
    },
  };
}
