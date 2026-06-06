import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "@codesymphony/shared-types";
import { resetModelProvidersCollectionRegistryForTest } from "../../../collections/modelProviders";
import { useModelProviders } from "./useModelProviders";

const apiMocks = vi.hoisted(() => ({
  listModelProviders: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  api: {
    listModelProviders: apiMocks.listModelProviders,
  },
}));

function makeProvider(overrides: Partial<ModelProvider> & { modelId?: string } = {}): ModelProvider {
  const providerId = overrides.id ?? "provider-1";
  const modelId = "modelId" in overrides && typeof overrides.modelId === "string"
    ? overrides.modelId
    : "claude-custom";
  return {
    id: providerId,
    name: "Custom",
    compatibility: "anthropic",
    baseUrl: "https://example.com",
    apiKeyMasked: "••••",
    models: [{
      id: `${providerId}-model`,
      providerId,
      modelId,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let latestHook: ReturnType<typeof useModelProviders> | null = null;

function HookHarness({ enabled = true }: { enabled?: boolean }) {
  latestHook = useModelProviders({ enabled });
  return (
    <div>
      {latestHook.providers.length === 0
        ? "empty"
        : latestHook.providers.map((provider) => provider.models?.[0]?.modelId ?? "missing-model").join(",")}
    </div>
  );
}

beforeEach(() => {
  resetModelProvidersCollectionRegistryForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  latestHook = null;
  apiMocks.listModelProviders.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  resetModelProvidersCollectionRegistryForTest();
  queryClient.clear();
  container.remove();
});

function renderHarness(options?: { enabled?: boolean }) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness enabled={options?.enabled} />
      </QueryClientProvider>,
    );
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useModelProviders", () => {
  it("stays inert when disabled", async () => {
    renderHarness({ enabled: false });
    await flushEffects();

    expect(container.textContent).toBe("empty");
    expect(apiMocks.listModelProviders).not.toHaveBeenCalled();
  });

  it("loads providers from the initial fetch", async () => {
    apiMocks.listModelProviders.mockResolvedValueOnce([makeProvider({ id: "initial", modelId: "claude-initial" })]);

    renderHarness();
    await flushEffects();

    expect(container.textContent).toContain("claude-initial");
  });

  it("replaces the shared provider collection locally", async () => {
    apiMocks.listModelProviders.mockResolvedValueOnce([]);

    renderHarness();
    await flushEffects();
    expect(container.textContent).toBe("empty");

    act(() => {
      latestHook?.replaceProviders([makeProvider({ id: "fresh", modelId: "claude-fresh" })]);
    });

    expect(container.textContent).toContain("claude-fresh");
  });

  it("refreshes providers from the server on demand", async () => {
    apiMocks.listModelProviders
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeProvider({ id: "latest", modelId: "claude-latest" })]);

    renderHarness();
    await flushEffects();
    expect(container.textContent).toBe("empty");

    await act(async () => {
      await latestHook?.refreshProviders();
    });

    expect(container.textContent).toContain("claude-latest");
  });

  it("refreshes providers through the legacy selectProvider wrapper", async () => {
    apiMocks.listModelProviders
      .mockResolvedValueOnce([makeProvider({ id: "old", modelId: "claude-old" })])
      .mockResolvedValueOnce([makeProvider({ id: "fresh", modelId: "claude-fresh" })]);

    renderHarness();
    await flushEffects();
    expect(container.textContent).toContain("claude-old");

    await act(async () => {
      await latestHook?.selectProvider("fresh");
    });
    expect(container.textContent).toContain("claude-fresh");
  });
});
