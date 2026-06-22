import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryReviewState } from "@codesymphony/shared-types";
import { useRepositoryReviews } from "./useRepositoryReviews";

const { getRepositoryReviewsMock, runtimeBaseUrlMock } = vi.hoisted(() => ({
  getRepositoryReviewsMock: vi.fn(),
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
}));

vi.mock("../../lib/api", () => ({
  api: {
    getRepositoryReviews: getRepositoryReviewsMock,
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

  emitReviews(snapshot: RepositoryReviewState) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "live_resource",
        event: {
          resource: "repository_reviews",
          scopeId: "repo-1",
          seq: 1,
          snapshot,
          emittedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    } as MessageEvent<string>);
  }
}

function HookHarness() {
  const reviews = useRepositoryReviews("repo-1");
  const branchCount = Object.keys(reviews.data?.reviewsByBranch ?? {}).length;

  return (
    <div
      data-testid="result"
      data-available={reviews.data?.available ? "true" : "false"}
      data-state={reviews.connectionState}
      data-branch-count={String(branchCount)}
    />
  );
}

describe("useRepositoryReviews live updates", () => {
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
    getRepositoryReviewsMock.mockReset();
    getRepositoryReviewsMock.mockImplementation(() => new Promise<RepositoryReviewState>(() => {}));

    originalWebSocket = globalThis.WebSocket;
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    if (originalWebSocket) {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("subscribes to repository review snapshots over the shared workspace websocket", async () => {
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
        resource: "repository_reviews",
        scopeId: "repo-1",
      }],
    }));

    act(() => {
      MockWebSocket.instances[0]!.emitReviews({
        provider: "github",
        kind: "pr",
        available: true,
        reviewsByBranch: {
          main: {
            number: 123,
            display: "#123",
            url: "https://example.test/reviews/123",
            state: "open",
          },
        },
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

    expect(result.dataset.available).toBe("true");
    expect(result.dataset.state).toBe("healthy");
    expect(result.dataset.branchCount).toBe("1");
  });

  it("keeps cached review badges when a later live snapshot is unavailable", async () => {
    queryClient.setQueryData(["repositories", "repo-1", "reviews"], {
      provider: "github",
      kind: "pr",
      available: true,
      reviewsByBranch: {
        "feature-x": {
          number: 12,
          display: "#12",
          url: "https://example.test/reviews/12",
          state: "open",
        },
      },
    } satisfies RepositoryReviewState);

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
      MockWebSocket.instances[0]!.emitReviews({
        provider: "github",
        kind: "pr",
        available: false,
        unavailableReason: "gh is not installed",
        reviewsByBranch: {},
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

    expect(result.dataset.available).toBe("false");
    expect(result.dataset.branchCount).toBe("1");
  });

  it("keeps cached review badges when the REST query result is unavailable", async () => {
    let resolveQuery: ((value: RepositoryReviewState) => void) | null = null;
    getRepositoryReviewsMock.mockImplementation(
      () =>
        new Promise<RepositoryReviewState>((resolve) => {
          resolveQuery = resolve;
        }),
    );

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
      MockWebSocket.instances[0]!.emitReviews({
        provider: "github",
        kind: "pr",
        available: true,
        reviewsByBranch: {
          main: {
            number: 123,
            display: "#123",
            url: "https://example.test/reviews/123",
            state: "open",
          },
        },
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
    expect(result.dataset.branchCount).toBe("1");

    // A REST fetch (initial load or refetch) comes back unavailable. This path
    // bypasses the live-socket merge, so without protection it wipes the badge.
    await act(async () => {
      resolveQuery?.({
        provider: "github",
        kind: "pr",
        available: false,
        unavailableReason: "Review integration is unavailable",
        reviewsByBranch: {},
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.dataset.branchCount).toBe("1");
  });
});
