import type { PrismaClient } from "@prisma/client";
import {
  type CreateModelProviderInput,
  type CreateModelProviderModelInput,
  type ModelProvider,
  type ModelProviderCompatibility,
  type UpdateModelProviderInput,
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

function normalizeRequired(value: string): string {
  return value.trim();
}

type ProviderWithChildren = {
  id: string;
  name: string;
  compatibility: ModelProviderCompatibility;
  baseUrl: string | null;
  apiKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  models: Array<{
    id: string;
    providerId: string;
    modelId: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

function mapProvider(provider: ProviderWithChildren): ModelProvider {
  return {
    id: provider.id,
    name: provider.name,
    compatibility: provider.compatibility,
    baseUrl: provider.baseUrl,
    apiKeyMasked: provider.apiKey ? maskApiKey(provider.apiKey) : "",
    models: provider.models.map((model) => ({
      id: model.id,
      providerId: model.providerId,
      modelId: model.modelId,
      createdAt: model.createdAt.toISOString(),
      updatedAt: model.updatedAt.toISOString(),
    })),
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

const providerInclude = {
  models: {
    orderBy: [
      { createdAt: "asc" as const },
      { id: "asc" as const },
    ],
  },
};

function ensureUniqueModelIds(models: readonly { modelId: string }[]): void {
  const seen = new Set<string>();
  for (const model of models) {
    const normalized = normalizeRequired(model.modelId);
    if (seen.has(normalized)) {
      throw new Error("Model IDs must be unique within a provider");
    }
    seen.add(normalized);
  }
}

export function createModelProviderService(prisma: PrismaClient) {
  return {
    async listProviders(): Promise<ModelProvider[]> {
      const providers = await prisma.modelProvider.findMany({
        include: providerInclude,
        orderBy: [
          { createdAt: "asc" },
          { id: "asc" },
        ],
      });
      return providers.map(mapProvider);
    },

    async createProvider(input: CreateModelProviderInput): Promise<ModelProvider> {
      ensureUniqueModelIds(input.models);
      const provider = await prisma.modelProvider.create({
        data: {
          name: normalizeRequired(input.name),
          compatibility: input.compatibility,
          baseUrl: normalizeOptionalSecret(input.baseUrl),
          apiKey: normalizeOptionalSecret(input.apiKey),
          models: {
            create: input.models.map((model) => ({
              modelId: normalizeRequired(model.modelId),
            })),
          },
        },
        include: providerInclude,
      });
      return mapProvider(provider);
    },

    async updateProvider(id: string, input: UpdateModelProviderInput): Promise<ModelProvider> {
      const provider = await prisma.modelProvider.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: normalizeRequired(input.name) } : {}),
          ...(input.compatibility !== undefined ? { compatibility: input.compatibility } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: normalizeOptionalSecret(input.baseUrl) } : {}),
          ...(input.apiKey !== undefined ? { apiKey: normalizeOptionalSecret(input.apiKey) } : {}),
        },
        include: providerInclude,
      });
      return mapProvider(provider);
    },

    async deleteProvider(id: string): Promise<void> {
      await prisma.modelProvider.delete({ where: { id } });
    },

    async createModel(providerId: string, input: CreateModelProviderModelInput): Promise<ModelProvider> {
      const modelId = normalizeRequired(input.modelId);
      const existing = await prisma.modelProviderModel.findFirst({
        where: { providerId, modelId },
        select: { id: true },
      });
      if (existing) {
        throw new Error("Model ID already exists for this provider");
      }
      await prisma.modelProviderModel.create({
        data: { providerId, modelId },
      });
      const provider = await prisma.modelProvider.findUniqueOrThrow({
        where: { id: providerId },
        include: providerInclude,
      });
      return mapProvider(provider);
    },

    async deleteModel(modelRowId: string): Promise<void> {
      await prisma.modelProviderModel.delete({ where: { id: modelRowId } });
    },

    async resolveProviderSelection(providerId: string, modelId: string): Promise<{
      id: string;
      compatibility: ModelProviderCompatibility;
      apiKey: string | null;
      baseUrl: string | null;
      name: string;
      modelId: string;
    } | null> {
      const provider = await prisma.modelProvider.findUnique({
        where: { id: providerId },
        include: { models: true },
      });
      if (!provider) {
        return null;
      }
      const normalizedModelId = normalizeRequired(modelId);
      const hasModel = provider.models.some((model) => model.modelId === normalizedModelId);
      if (!hasModel) {
        throw new Error("Selected model is no longer available in this provider");
      }
      return {
        id: provider.id,
        compatibility: provider.compatibility,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        name: provider.name,
        modelId: normalizedModelId,
      };
    },
  };
}
