import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@codesymphony/shared-types";
import { resetGitStatusCollectionRegistryForTest } from "../../collections/gitStatus";
import { useGitStatus } from "./useGitStatus";

const { getGitStatusMock, runtimeBaseUrlMock } = vi.hoisted(() => ({
  getGitStatusMock: vi.fn(),
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
}));

vi.mock("../../lib/api", () => ({
  api: {
    getGitStatus: getGitStatusMock,
    get runtimeBaseUrl() {
      return runtimeBaseUrlMock;
    },
  },
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" } as CloseEvent);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emitGitStatus(snapshot: GitStatus) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "live_resource",
        event: {
          resource: "git_status",
          scopeId: "wt-1",
          seq: 1,
          snapshot,
          emittedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    } as MessageEvent<string>);
  }

  emitGitStatusError(message: string) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "live_resource_error",
        resource: "git_status",
        scopeId: "wt-1",
        message,
      }),
    } as MessageEvent<string>);
  }
}

function HookHarness() {
  const gitStatus = useGitStatus("wt-1");

  return (
    <div
      data-testid="result"
      data-branch={gitStatus.data?.branch ?? ""}
      data-state={gitStatus.connectionState}
      data-entry-count={String(gitStatus.data?.entries.length ?? 0)}
      data-error={gitStatus.error == null ? "" : String(gitStatus.error)}
    />
  );
}

describe("useGitStatus live updates", () => {
  let originalWebSocket: typeof WebSocket | undefined;
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    getGitStatusMock.mockReset();
    getGitStatusMock.mockImplementation(() => new Promise<GitStatus>(() => {}));

    originalWebSocket = globalThis.WebSocket;
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    MockWebSocket.instances = [];
  });

  afterEach(async () => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    if (originalWebSocket) {
      globalThis.WebSocket = originalWebSocket;
    }
    await resetGitStatusCollectionRegistryForTest();
  });

  it("subscribes to git status snapshots over the shared workspace websocket", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HookHarness />
        </QueryClientProvider>,
      );
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.url).toBe("ws://127.0.0.1:4331/api/workspace/live/ws");

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    expect(MockWebSocket.instances[0]!.sentMessages).toContain(JSON.stringify({
      type: "subscribe",
      subscriptions: [{
        type: "live_resource",
        resource: "git_status",
        scopeId: "wt-1",
      }],
    }));

    act(() => {
      MockWebSocket.instances[0]!.emitGitStatus({
        branch: "feature/live-ws",
        upstream: "origin/feature/live-ws",
        ahead: 2,
        behind: 0,
        entries: [{
          path: "src/live.ts",
          status: "modified",
          insertions: 12,
          deletions: 3,
        }],
      });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const result = container.querySelector<HTMLElement>('[data-testid="result"]');
    if (!result) {
      throw new Error("Result not found");
    }

    expect(result.dataset.branch).toBe("feature/live-ws");
    expect(result.dataset.state).toBe("healthy");
    expect(result.dataset.entryCount).toBe("1");
  });

  it("marks the live resource exhausted when the server rejects the subscription", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HookHarness />
        </QueryClientProvider>,
      );
    });

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    act(() => {
      MockWebSocket.instances[0]!.emitGitStatusError("Worktree path not found");
    });

    await act(async () => {
      await Promise.resolve();
    });

    const result = container.querySelector<HTMLElement>('[data-testid="result"]');
    if (!result) {
      throw new Error("Result not found");
    }

    expect(result.dataset.state).toBe("exhausted");
    expect(result.dataset.error).toContain("Worktree path not found");
  });

  it("does not fallback-refetch when the server reports an unavailable worktree", async () => {
    getGitStatusMock.mockResolvedValue({
      branch: "feature/live-ws",
      upstream: "origin/feature/live-ws",
      ahead: 0,
      behind: 0,
      entries: [],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HookHarness />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(1);

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    act(() => {
      MockWebSocket.instances[0]!.emitGitStatusError("Worktree path not found: /tmp/codesymphony");
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(1);
  });

  it("still fallback-refetches for generic live resource errors", async () => {
    getGitStatusMock.mockResolvedValue({
      branch: "feature/live-ws",
      upstream: "origin/feature/live-ws",
      ahead: 0,
      behind: 0,
      entries: [],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HookHarness />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(1);

    act(() => {
      MockWebSocket.instances[0]!.open();
    });

    act(() => {
      MockWebSocket.instances[0]!.emitGitStatusError("Permission denied");
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(2);
  });

  it("returns to healthy when a resubscription replays the cached snapshot seq", async () => {
    getGitStatusMock.mockResolvedValue({
      branch: "feature/live-ws",
      upstream: "origin/feature/live-ws",
      ahead: 0,
      behind: 0,
      entries: [],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <HookHarness />
        </QueryClientProvider>,
      );
    });

    act(() => {
      MockWebSocket.instances[0]!.open();
      MockWebSocket.instances[0]!.emitGitStatus({
        branch: "feature/live-ws",
        upstream: "origin/feature/live-ws",
        ahead: 0,
        behind: 0,
        entries: [],
      });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstSocket = MockWebSocket.instances[0]!;
    const firstResult = container.querySelector<HTMLElement>('[data-testid="result"]');
    if (!firstResult) {
      throw new Error("Result not found");
    }
    expect(firstResult.dataset.state).toBe("healthy");

    act(() => {
      root.unmount();
    });

    act(() => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <HookHarness />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const reconnectingResult = container.querySelector<HTMLElement>('[data-testid="result"]');
    if (!reconnectingResult) {
      throw new Error("Result not found");
    }

    expect(reconnectingResult.dataset.state).toBe("connecting");

    const secondSocket = MockWebSocket.instances.at(-1)!;
    expect(secondSocket).not.toBe(firstSocket);

    act(() => {
      secondSocket.open();
      secondSocket.emitGitStatus({
        branch: "feature/live-ws",
        upstream: "origin/feature/live-ws",
        ahead: 0,
        behind: 0,
        entries: [],
      });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const secondResult = container.querySelector<HTMLElement>('[data-testid="result"]');
    if (!secondResult) {
      throw new Error("Result not found");
    }

    expect(secondResult.dataset.state).toBe("healthy");
  });
});
