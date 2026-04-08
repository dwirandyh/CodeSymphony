import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelProvider } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";

export function useModelProviders() {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const requestVersionRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const replaceProviders = useCallback((nextProviders: ModelProvider[]) => {
    requestVersionRef.current += 1;
    if (mountedRef.current) {
      setProviders(nextProviders);
    }
  }, []);

  const refreshProviders = useCallback(async (): Promise<ModelProvider[]> => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    const nextProviders = await api.listModelProviders();
    if (mountedRef.current && requestVersionRef.current === requestVersion) {
      setProviders(nextProviders);
    }

    return nextProviders;
  }, []);

  const selectProvider = useCallback(async (id: string | null): Promise<ModelProvider[]> => {
    if (id === null) {
      await api.deactivateAllProviders();
    } else {
      await api.activateModelProvider(id);
    }

    return refreshProviders();
  }, [refreshProviders]);

  useEffect(() => {
    void refreshProviders().catch(() => {});
  }, [refreshProviders]);

  return {
    providers,
    refreshProviders,
    replaceProviders,
    selectProvider,
  };
}
