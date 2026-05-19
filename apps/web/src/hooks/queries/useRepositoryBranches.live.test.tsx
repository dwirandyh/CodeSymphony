import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRepositoryBranches } from "./useRepositoryBranches";

const { listBranchesMock, runtimeBaseUrlMock } = vi.hoisted(() => ({
  listBranchesMock: vi.fn(),
  runtimeBaseUrlMock: "http://127.0.0.1:4331",
}));

vi.mock("../../lib/api", () => ({
  api: {
    listBranches: listBranchesMock,
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

  emitBranches(snapshot: string[]) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "live_resource",
        event: {
          resource: "repository_branches",
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
  const branches = useRepositoryBranches("repo-1");

  return (
    <div
      data-testid="result"
      data-count={String(branches.data?.length ?? 0)}
      data-first-branch={branches.data?.[0] ?? ""}
      data-state={branches.connectionState}
    />
  );
}

describe("useRepositoryBranches live updates", () => {
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
    listBranchesMock.mockReset();
    listBranchesMock.mockImplementation(() => new Promise<string[]>(() => {}));

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

  it("subscribes to repository branch snapshots over the shared workspace websocket", async () => {
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
        resource: "repository_branches",
        scopeId: "repo-1",
      }],
    }));

    act(() => {
      MockWebSocket.instances[0]!.emitBranches(["main", "feature/live-ws"]);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const result = container.querySelector<HTMLElement>('[data-testid="result"]');
    if (!result) {
      throw new Error("Result not found");
    }

    expect(result.dataset.count).toBe("2");
    expect(result.dataset.firstBranch).toBe("main");
    expect(result.dataset.state).toBe("healthy");
  });
});
