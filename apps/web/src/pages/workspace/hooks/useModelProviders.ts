import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { ModelProvider } from "@codesymphony/shared-types";
import { getModelProvidersCollection, toPlainModelProvider } from "../../../collections/modelProviders";
import { api } from "../../../lib/api";

export function useModelProviders(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const collection = useMemo(
    () => enabled ? getModelProvidersCollection(queryClient) : null,
    [enabled, queryClient],
  );
  const { data: liveProviders, isLoading } = useLiveQuery(() => collection ?? undefined, [collection]);
  const providers = useMemo(
    () => liveProviders?.map((provider) => toPlainModelProvider(provider as ModelProvider)) ?? [],
    [liveProviders],
  );

  const replaceProviders = useCallback((nextProviders: ModelProvider[]) => {
    if (!collection) {
      return;
    }

    const nextById = new Map(nextProviders.map((provider) => [provider.id, provider] as const));
    const currentIds = (collection.toArray as ModelProvider[]).map((provider) => provider.id);

    collection.utils.writeBatch(() => {
      for (const providerId of currentIds) {
        if (!nextById.has(providerId)) {
          collection.utils.writeDelete(providerId);
        }
      }
      for (const provider of nextProviders) {
        collection.utils.writeUpsert(provider);
      }
    });
  }, [collection]);

  const refreshProviders = useCallback(async (): Promise<ModelProvider[]> => {
    if (!collection) {
      return [];
    }

    await collection.utils.refetch();
    return (collection.toArray as ModelProvider[]).map((provider) => toPlainModelProvider(provider));
  }, [collection]);

  const selectProvider = useCallback(async (id: string | null): Promise<ModelProvider[]> => {
    if (!collection) {
      return [];
    }

    if (id === null) {
      await api.deactivateAllProviders();
      const currentProviders = (collection.toArray as ModelProvider[]).map((provider) => ({
        ...provider,
        isActive: false,
      }));
      replaceProviders(currentProviders);
      return currentProviders.map((provider) => toPlainModelProvider(provider));
    }

    const activeProvider = await api.activateModelProvider(id);
    const nextProviders = (collection.toArray as ModelProvider[])
      .map((provider) => ({
        ...provider,
        isActive: false,
      }));

    const nextById = new Map(nextProviders.map((provider) => [provider.id, provider] as const));
    nextById.set(activeProvider.id, activeProvider);
    replaceProviders([...nextById.values()].map((provider) => toPlainModelProvider(provider)));

    return [...nextById.values()].map((provider) => toPlainModelProvider(provider));
  }, [collection, replaceProviders]);

  return {
    providers,
    loading: collection ? isLoading || collection.utils.isLoading : false,
    refreshProviders,
    replaceProviders,
    selectProvider,
  };
}
