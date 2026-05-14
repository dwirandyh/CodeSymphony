import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Repository, ResourceMonitorRuntimeSnapshot } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { getDesktopResourceMonitorSnapshot } from "../../lib/desktopResourceMonitor";
import { ResourceMonitor } from "./ResourceMonitor";

vi.mock("../../lib/api", () => ({
  api: {
    getResourceMonitorSnapshot: vi.fn(),
  },
}));

vi.mock("../../lib/desktopResourceMonitor", () => ({
  getDesktopResourceMonitorSnapshot: vi.fn(),
}));

const runtimeSnapshot: ResourceMonitorRuntimeSnapshot = {
  runtime: {
    pid: 4321,
    cpu: 1.5,
    memory: 80 * 1024 * 1024,
  },
  worktrees: [],
  host: {
    totalMemory: 16 * 1024 * 1024 * 1024,
    freeMemory: 8 * 1024 * 1024 * 1024,
    usedMemory: 8 * 1024 * 1024 * 1024,
    memoryUsagePercent: 50,
    cpuCoreCount: 8,
    loadAverage1m: 1.2,
  },
  collectedAt: Date.now(),
};

const activeSessionsSnapshot: ResourceMonitorRuntimeSnapshot = {
  runtime: {
    pid: 4321,
    cpu: 1.5,
    memory: 80 * 1024 * 1024,
  },
  worktrees: [
    {
      worktreeId: "wt-1",
      repositoryId: "repo-1",
      repositoryName: "Repo One",
      worktreeName: "main",
      cpu: 12,
      memory: 150 * 1024 * 1024,
      sessions: [
        {
          sessionId: "thread:t-1:agent:claude",
          worktreeId: "wt-1",
          pid: 5001,
          label: "Agent: Claude | Investigate monitor",
          kind: "other",
          cpu: 5,
          memory: 70 * 1024 * 1024,
        },
        {
          sessionId: "thread:t-2:agent:codex",
          worktreeId: "wt-1",
          pid: 5002,
          label: "Agent: Codex | Tighten desktop metrics",
          kind: "other",
          cpu: 7,
          memory: 80 * 1024 * 1024,
        },
      ],
    },
  ],
  host: {
    totalMemory: 16 * 1024 * 1024 * 1024,
    freeMemory: 8 * 1024 * 1024 * 1024,
    usedMemory: 8 * 1024 * 1024 * 1024,
    memoryUsagePercent: 50,
    cpuCoreCount: 8,
    loadAverage1m: 1.2,
  },
  collectedAt: Date.now(),
};

const desktopSnapshot = {
  shell: { cpu: 0, memory: 0 },
  webview: { cpu: 0, memory: 0 },
  runtime: { cpu: 1.5, memory: 80 * 1024 * 1024 },
  other: { cpu: 0, memory: 0 },
};

const repositories = [
  {
    id: "repo-1",
    name: "Repo One",
    rootPath: "/repo-one",
    worktrees: [
      {
        id: "wt-1",
        branch: "main",
        path: "/repo-one",
        status: "active",
      },
    ],
  },
] as unknown as Repository[];

describe("ResourceMonitor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    vi.mocked(api.getResourceMonitorSnapshot).mockResolvedValue(runtimeSnapshot);
    vi.mocked(getDesktopResourceMonitorSnapshot).mockResolvedValue(desktopSnapshot);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function renderResourceMonitor(overrides?: Partial<Parameters<typeof ResourceMonitor>[0]>) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ResourceMonitor
            desktopApp
            runtimePid={4321}
            repositories={repositories}
            onSelectWorktree={vi.fn()}
            onSelectSession={vi.fn()}
            {...overrides}
          />
        </QueryClientProvider>
      );
    });
  }

  it("refetches the latest snapshot when the popover opens", async () => {
    renderResourceMonitor();
    await flush();

    expect(api.getResourceMonitorSnapshot).toHaveBeenCalledTimes(1);
    expect(getDesktopResourceMonitorSnapshot).toHaveBeenCalledTimes(1);

    const trigger = document.body.querySelector<HTMLButtonElement>('[data-testid="resource-monitor-trigger"]');
    if (!trigger) {
      throw new Error("Resource monitor trigger not found");
    }

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    await flush();

    expect(api.getResourceMonitorSnapshot).toHaveBeenCalledTimes(2);
    expect(getDesktopResourceMonitorSnapshot).toHaveBeenCalledTimes(2);
  });

  it("shows the tracked-worktree empty state when no worktree activity exists", async () => {
    renderResourceMonitor();
    await flush();

    const trigger = document.body.querySelector<HTMLButtonElement>('[data-testid="resource-monitor-trigger"]');
    if (!trigger) {
      throw new Error("Resource monitor trigger not found");
    }

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    await flush();

    expect(document.body.textContent).toContain("No tracked worktree activity");
  });

  it("falls back to runtime-only metrics when desktop metrics stall", async () => {
    vi.mocked(getDesktopResourceMonitorSnapshot).mockImplementation(
      () => new Promise(() => undefined),
    );

    renderResourceMonitor();
    await flush();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("80.0 MB");
  });

  it("shows multiple active agent sessions for the same worktree", async () => {
    vi.mocked(api.getResourceMonitorSnapshot).mockResolvedValue(activeSessionsSnapshot);

    renderResourceMonitor();
    await flush();

    const trigger = document.body.querySelector<HTMLButtonElement>('[data-testid="resource-monitor-trigger"]');
    if (!trigger) {
      throw new Error("Resource monitor trigger not found");
    }

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    await flush();

    expect(document.body.textContent).toContain("Agent: Claude | Investigate monitor");
    expect(document.body.textContent).toContain("Agent: Codex | Tighten desktop metrics");
  });
});
