import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "@codesymphony/shared-types";
import { resetModelProvidersCollectionRegistryForTest } from "../../../collections/modelProviders";
import { useModelProviders } from "./useModelProviders";

const apiMocks = vi.hoisted(() => ({
  listModelProviders: vi.fn(),
  activateModelProvider: vi.fn(),
  deactivateAllProviders: vi.fn(),
}));

vi.mock("../../../lib/api", () => ({
  api: {
    listModelProviders: apiMocks.listModelProviders,
    activateModelProvider: apiMocks.activateModelProvider,
    deactivateAllProviders: apiMocks.deactivateAllProviders,
  },
}));

function makeProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "provider-1",
    name: "Custom",
    modelId: "claude-custom",
    baseUrl: "https://example.com",
    apiKeyMasked: "••••",
    isActive: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let latestHook: ReturnType<typeof useModelProviders> | null = null;

function HookHarness() {
  latestHook = useModelProviders();
  return (
    <div>
      {latestHook.providers.length === 0
        ? "empty"
        : latestHook.providers.map((provider) => `${provider.modelId}:${provider.isActive ? "active" : "idle"}`).join(",")}
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
  apiMocks.activateModelProvider.mockReset();
  apiMocks.deactivateAllProviders.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  resetModelProvidersCollectionRegistryForTest();
  container.remove();
});

function renderHarness() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness />
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
  it("loads providers from the initial fetch", async () => {
    apiMocks.listModelProviders.mockResolvedValueOnce([makeProvider({ id: "initial", modelId: "claude-initial" })]);

    renderHarness();
    await flushEffects();

    expect(container.textContent).toContain("claude-initial:idle");
  });

  it("replaces the shared provider collection locally", async () => {
    apiMocks.listModelProviders.mockResolvedValueOnce([]);

    renderHarness();
    await flushEffects();
    expect(container.textContent).toBe("empty");

    act(() => {
      latestHook?.replaceProviders([makeProvider({ id: "fresh", modelId: "claude-fresh" })]);
    });

    expect(container.textContent).toContain("claude-fresh:idle");
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

    expect(container.textContent).toContain("claude-latest:idle");
  });

  it("updates active provider flags when activating and deactivating", async () => {
    apiMocks.listModelProviders.mockResolvedValueOnce([
      makeProvider({ id: "old", modelId: "claude-old" }),
      makeProvider({ id: "active", modelId: "claude-active" }),
    ]);

    renderHarness();
    await flushEffects();

    apiMocks.activateModelProvider.mockResolvedValue(
      makeProvider({ id: "active", modelId: "claude-active", isActive: true }),
    );
    await act(async () => {
      await latestHook?.selectProvider("active");
    });
    expect(apiMocks.activateModelProvider).toHaveBeenCalledWith("active");
    expect(container.textContent).toContain("claude-active:active");
    expect(container.textContent).toContain("claude-old:idle");

    apiMocks.deactivateAllProviders.mockResolvedValue(undefined);
    await act(async () => {
      await latestHook?.selectProvider(null);
    });
    expect(apiMocks.deactivateAllProviders).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("claude-active:idle");
    expect(container.textContent).toContain("claude-old:idle");
  });
});
