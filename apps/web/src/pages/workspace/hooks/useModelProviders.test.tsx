import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "@codesymphony/shared-types";
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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
let latestHook: ReturnType<typeof useModelProviders> | null = null;

function HookHarness() {
  latestHook = useModelProviders();
  return (
    <div>
      {latestHook.providers.length === 0
        ? "empty"
        : latestHook.providers.map((provider) => provider.modelId).join(",")}
    </div>
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latestHook = null;
  apiMocks.listModelProviders.mockReset();
  apiMocks.activateModelProvider.mockReset();
  apiMocks.deactivateAllProviders.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useModelProviders", () => {
  it("loads providers from the initial fetch", async () => {
    apiMocks.listModelProviders.mockResolvedValueOnce([makeProvider({ id: "initial", modelId: "claude-initial" })]);

    act(() => {
      root.render(<HookHarness />);
    });

    await flushEffects();

    expect(container.textContent).toContain("claude-initial");
  });

  it("does not let an older fetch overwrite newer synced providers", async () => {
    const staleRequest = createDeferred<ModelProvider[]>();
    apiMocks.listModelProviders.mockImplementationOnce(() => staleRequest.promise);

    act(() => {
      root.render(<HookHarness />);
    });

    expect(container.textContent).toBe("empty");

    act(() => {
      latestHook?.replaceProviders([makeProvider({ id: "fresh", modelId: "claude-fresh" })]);
    });

    expect(container.textContent).toContain("claude-fresh");

    staleRequest.resolve([makeProvider({ id: "stale", modelId: "claude-stale" })]);
    await flushEffects();

    expect(container.textContent).toContain("claude-fresh");
    expect(container.textContent).not.toContain("claude-stale");
  });

  it("keeps the latest refresh result when requests resolve out of order", async () => {
    apiMocks.listModelProviders.mockResolvedValueOnce([]);

    act(() => {
      root.render(<HookHarness />);
    });
    await flushEffects();

    const firstRefresh = createDeferred<ModelProvider[]>();
    const secondRefresh = createDeferred<ModelProvider[]>();
    apiMocks.listModelProviders
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => secondRefresh.promise);

    act(() => {
      void latestHook?.refreshProviders();
      void latestHook?.refreshProviders();
    });

    secondRefresh.resolve([makeProvider({ id: "latest", modelId: "claude-latest" })]);
    await flushEffects();
    expect(container.textContent).toContain("claude-latest");

    firstRefresh.resolve([makeProvider({ id: "older", modelId: "claude-older" })]);
    await flushEffects();
    expect(container.textContent).toContain("claude-latest");
    expect(container.textContent).not.toContain("claude-older");
  });

  it("refreshes providers after activating and deactivating a provider", async () => {
    apiMocks.listModelProviders
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeProvider({ id: "active", modelId: "claude-active", isActive: true })])
      .mockResolvedValueOnce([]);

    act(() => {
      root.render(<HookHarness />);
    });
    await flushEffects();

    apiMocks.activateModelProvider.mockResolvedValue(undefined);
    await act(async () => {
      await latestHook?.selectProvider("active");
    });
    expect(apiMocks.activateModelProvider).toHaveBeenCalledWith("active");
    expect(container.textContent).toContain("claude-active");

    apiMocks.deactivateAllProviders.mockResolvedValue(undefined);
    await act(async () => {
      await latestHook?.selectProvider(null);
    });
    expect(apiMocks.deactivateAllProviders).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("empty");
  });
});
