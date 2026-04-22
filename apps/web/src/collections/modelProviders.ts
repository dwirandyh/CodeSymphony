import { createCollection } from "@tanstack/db";
import type { ModelProvider } from "@codesymphony/shared-types";
import type { QueryClient } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { api } from "../lib/api";

function compareProviders(left: ModelProvider, right: ModelProvider) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function toPlainModelProvider(provider: ModelProvider): ModelProvider {
  return {
    id: provider.id,
    agent: provider.agent ?? "claude",
    name: provider.name,
    modelId: provider.modelId,
    baseUrl: provider.baseUrl ?? null,
    apiKeyMasked: provider.apiKeyMasked,
    isActive: provider.isActive,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function createModelProvidersCollection(queryClient: QueryClient) {
  return createCollection(
    queryCollectionOptions<ModelProvider>({
      id: "model-providers",
      queryKey: ["model-providers"],
      queryFn: () => api.listModelProviders(),
      queryClient,
      getKey: (provider) => provider.id,
      compare: compareProviders,
      staleTime: 10_000,
    }),
  );
}

type ModelProvidersCollection = ReturnType<typeof createModelProvidersCollection>;

const modelProvidersCollectionRegistry = new Map<QueryClient, ModelProvidersCollection>();

export function getModelProvidersCollection(queryClient: QueryClient): ModelProvidersCollection {
  const existing = modelProvidersCollectionRegistry.get(queryClient);
  if (existing) {
    return existing;
  }

  const created = createModelProvidersCollection(queryClient);
  modelProvidersCollectionRegistry.set(queryClient, created);
  return created;
}

export function refetchModelProvidersCollection(queryClient: QueryClient) {
  return getModelProvidersCollection(queryClient).utils.refetch();
}

export function resetModelProvidersCollectionRegistryForTest() {
  for (const collection of modelProvidersCollectionRegistry.values()) {
    void collection.cleanup();
  }
  modelProvidersCollectionRegistry.clear();
}
