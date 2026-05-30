import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, ChatTimelineSnapshot } from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { resetThreadCollectionsForTest } from "../../../../collections/threadCollections";
import { resetThreadStreamStateRegistryForTest } from "../../../../collections/threadStreamState";
import { resetPendingAutoCreateWorktreesForTest, useChatSession } from "./useChatSession";

const { threadsState } = vi.hoisted(() => ({
  threadsState: {
    data: undefined as ChatThread[] | undefined,
    isLoading: false,
    isFetching: false,
    error: null as Error | null,
    isError: false,
  },
}));

vi.mock("../../../../hooks/queries/useThreads", () => ({
  useThreads: vi.fn(() => ({
    data: threadsState.data,
    isLoading: threadsState.isLoading,
    isFetching: threadsState.isFetching,
    error: threadsState.error,
    isError: threadsState.isError,
  })),
}));

vi.mock("../../../../hooks/queries/useThreadSnapshot", () => ({
  useThreadSnapshot: vi.fn(() => ({
    data: null as ChatTimelineSnapshot | null,
    isLoading: false,
    isFetching: false,
  })),
}));

vi.mock("../../../../hooks/queries/useThreadStatusSnapshot", () => ({
  useThreadStatusSnapshot: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
  })),
}));

vi.mock("./useThreadEventStream", () => ({
  useThreadEventStream: vi.fn(),
}));

vi.mock("../workspace-timeline", () => ({
  useWorkspaceTimeline: vi.fn(() => ({
    items: [],
    hasIncompleteCoverage: false,
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
  })),
}));

vi.mock("../../../../hooks/queries/useRepositoryReviews", () => ({
  requestRepositoryReviewsLiveRefresh: vi.fn(),
}));

vi.mock("../../../../lib/idleTask", () => ({
  scheduleWindowIdleTask: vi.fn(() => () => undefined),
}));

vi.mock("../../../../lib/renderDebug", () => ({
  pushRenderDebug: vi.fn(),
}));

vi.mock("../../../../lib/threadNavigationPerf", () => ({
  isThreadNavigationPerfEnabled: vi.fn(() => false),
  pushThreadNavigationPerf: vi.fn(),
}));

vi.mock("../../../../lib/api", () => ({
  api: {
    createThread: vi.fn(),
    getOrCreatePrMrThread: vi.fn(),
    getTimelineSnapshot: vi.fn(),
    listQueuedMessages: vi.fn(),
    renameThreadTitle: vi.fn(),
    updateThreadMode: vi.fn(),
    updateThreadAgentSelection: vi.fn(),
    updateThreadPermissionMode: vi.fn(),
    deleteThread: vi.fn(),
    sendMessage: vi.fn(),
    stopRun: vi.fn(),
  },
}));

function act(callback: () => void): void;
function act(callback: () => Promise<void>): Promise<void>;
function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });

  if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
    return result.then(() => Promise.resolve());
  }

  return undefined;
}

function makeThread(id: string, worktreeId = "wt-1"): ChatThread {
  return {
    id,
    worktreeId,
    title: id,
    kind: "default",
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    agent: "claude",
    model: "claude-sonnet-4-6",
    modelProviderId: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    opencodeSessionId: null,
    active: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let hookResult: ReturnType<typeof useChatSession>;
let renderSnapshots: Array<{
  selectedWorktreeId: string | null | undefined;
  selectedThreadId: string | null;
  threadIds: string[];
  messageListEmptyState: ReturnType<typeof useChatSession>["messageListEmptyState"];
}>;

function HookHarness({ selectedWorktreeId }: { selectedWorktreeId: string | null }) {
  hookResult = useChatSession(selectedWorktreeId, vi.fn(), undefined, {
    autoCreateInitialThread: false,
  });
  renderSnapshots.push({
    selectedWorktreeId,
    selectedThreadId: hookResult.selectedThreadId,
    threadIds: hookResult.threads.map((thread) => thread.id),
    messageListEmptyState: hookResult.messageListEmptyState,
  });
  return null;
}

function renderHook(selectedWorktreeId: string | null) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness selectedWorktreeId={selectedWorktreeId} />
      </QueryClientProvider>,
    );
  });
}

describe("useChatSession worktree switch", () => {
  beforeEach(() => {
    resetPendingAutoCreateWorktreesForTest();
    resetThreadCollectionsForTest();
    resetThreadStreamStateRegistryForTest();
    threadsState.data = [makeThread("thread-a"), makeThread("thread-b")];
    threadsState.isLoading = false;
    threadsState.isFetching = false;
    threadsState.error = null;
    threadsState.isError = false;
    vi.mocked(api.listQueuedMessages).mockReset();
    vi.mocked(api.listQueuedMessages).mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderSnapshots = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    resetPendingAutoCreateWorktreesForTest();
    resetThreadCollectionsForTest();
    resetThreadStreamStateRegistryForTest();
  });

  it("does not expose stale selected thread state from the previous worktree during the first switch render", () => {
    renderHook("wt-1");

    act(() => {
      hookResult.setSelectedThreadId("thread-b");
    });

    expect(hookResult.selectedThreadId).toBe("thread-b");

    renderSnapshots = [];
    threadsState.data = [makeThread("thread-target", "wt-2")];

    renderHook("wt-2");

    expect(renderSnapshots).not.toContainEqual(expect.objectContaining({
      selectedWorktreeId: "wt-2",
      selectedThreadId: "thread-b",
    }));
    expect(renderSnapshots).not.toContainEqual(expect.objectContaining({
      selectedWorktreeId: "wt-2",
      threadIds: expect.arrayContaining(["thread-b"]),
    }));
  });
});
