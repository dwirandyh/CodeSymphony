import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatThread, ChatTimelineItem, ChatTimelineSnapshot } from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/queryKeys";
import { getThreadCollections } from "../../../../collections/threadCollections";
import { setThreadLastEventIdx, setThreadLastMessageSeq } from "../../../../collections/threadStreamState";
import { resetPendingAutoCreateWorktreesForTest, useChatSession } from "./useChatSession";

const { threadsState, snapshotState } = vi.hoisted(() => ({
  threadsState: {
    data: undefined as ChatThread[] | undefined,
    isLoading: false,
    isFetching: false,
  },
  snapshotState: {
    data: null as ChatTimelineSnapshot | null,
    isLoading: false,
    isFetching: false,
  },
}));

vi.mock("../../../../hooks/queries/useThreads", () => ({
  useThreads: vi.fn(() => ({
    data: threadsState.data,
    isLoading: threadsState.isLoading,
    isFetching: threadsState.isFetching,
  })),
}));

vi.mock("../../../../hooks/queries/useThreadSnapshot", () => ({
  useThreadSnapshot: vi.fn(() => ({
    data: snapshotState.data,
    isLoading: snapshotState.isLoading,
    isFetching: snapshotState.isFetching,
  })),
}));

vi.mock("./useThreadEventStream", () => ({
  useThreadEventStream: vi.fn(),
}));

const { useWorkspaceTimelineMock } = vi.hoisted(() => ({
  useWorkspaceTimelineMock: vi.fn(() => ({
    items: [],
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
  })),
}));

vi.mock("../workspace-timeline", () => ({
  useWorkspaceTimeline: useWorkspaceTimelineMock,
}));

const { pushThreadNavigationPerfMock } = vi.hoisted(() => ({
  pushThreadNavigationPerfMock: vi.fn(),
}));

const { threadNavigationPerfEnabledState } = vi.hoisted(() => ({
  threadNavigationPerfEnabledState: {
    value: true,
  },
}));

vi.mock("../../../../lib/renderDebug", () => ({
  pushRenderDebug: vi.fn(),
}));

vi.mock("../../../../lib/threadNavigationPerf", () => ({
  isThreadNavigationPerfEnabled: vi.fn(() => threadNavigationPerfEnabledState.value),
  pushThreadNavigationPerf: pushThreadNavigationPerfMock,
}));

vi.mock("../../../../lib/api", () => ({
  api: {
    createThread: vi.fn(),
    getOrCreatePrMrThread: vi.fn(),
    renameThreadTitle: vi.fn(),
    updateThreadMode: vi.fn(),
    updateThreadAgentSelection: vi.fn(),
    updateThreadPermissionMode: vi.fn(),
    deleteThread: vi.fn(),
    sendMessage: vi.fn(),
    stopRun: vi.fn(),
  },
}));

const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let hookResult: ReturnType<typeof useChatSession>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeThread(id: string, active = false): ChatThread {
  return {
    id,
    worktreeId: "wt-1",
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
    active,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function HookHarness({
  desiredThreadId,
  desiredWorktreeId,
  repositoryId = null,
  selectedWorktreeId = "wt-1",
}: {
  desiredThreadId?: string;
  desiredWorktreeId?: string | null;
  repositoryId?: string | null;
  selectedWorktreeId?: string | null;
}) {
  hookResult = useChatSession(selectedWorktreeId, vi.fn(), undefined, {
    desiredThreadId,
    desiredWorktreeId,
    repositoryId,
  });
  return null;
}

function renderHook(
  desiredThreadId?: string,
  repositoryId?: string | null,
  selectedWorktreeId: string | null = "wt-1",
  desiredWorktreeId?: string | null,
) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness
          desiredThreadId={desiredThreadId}
          desiredWorktreeId={desiredWorktreeId}
          repositoryId={repositoryId}
          selectedWorktreeId={selectedWorktreeId}
        />
      </QueryClientProvider>,
    );
  });
}

function renderHookInStrictMode(desiredThreadId?: string, repositoryId?: string | null) {
  act(() => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <HookHarness desiredThreadId={desiredThreadId} repositoryId={repositoryId} />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
}

function makeSnapshot(overrides?: Partial<ChatTimelineSnapshot>): ChatTimelineSnapshot {
  return {
    timelineItems: [],
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
    newestSeq: null,
    newestIdx: null,
    messages: [],
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetPendingAutoCreateWorktreesForTest();
  threadsState.data = [makeThread("thread-a"), makeThread("thread-b", true)];
  threadsState.isLoading = false;
  threadsState.isFetching = false;
  snapshotState.data = null;
  snapshotState.isLoading = false;
  snapshotState.isFetching = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  invalidateQueriesMock.mockReset();
  invalidateQueriesMock.mockResolvedValue(undefined);
  cancelQueriesMock.mockReset();
  cancelQueriesMock.mockResolvedValue(undefined);
  queryClient.invalidateQueries = invalidateQueriesMock as typeof queryClient.invalidateQueries;
  queryClient.cancelQueries = cancelQueriesMock as typeof queryClient.cancelQueries;
  threadNavigationPerfEnabledState.value = true;
  vi.mocked(api.createThread).mockReset();
  vi.mocked(api.getOrCreatePrMrThread).mockReset();
  vi.mocked(api.renameThreadTitle).mockReset();
  vi.mocked(api.updateThreadMode).mockReset();
  vi.mocked(api.updateThreadAgentSelection).mockReset();
  vi.mocked(api.updateThreadPermissionMode).mockReset();
  vi.mocked(api.deleteThread).mockReset();
  vi.mocked(api.sendMessage).mockReset();
  vi.mocked(api.stopRun).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  resetPendingAutoCreateWorktreesForTest();
  pushThreadNavigationPerfMock.mockReset();
  useWorkspaceTimelineMock.mockReset();
  useWorkspaceTimelineMock.mockReturnValue({
    items: [],
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
  });
});

describe("useChatSession", () => {
  it("keeps a locally selected thread while URL state catches up", () => {
    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-a");

    act(() => {
      hookResult.setSelectedThreadId("thread-b");
    });

    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-b");

    renderHook("thread-b");
    expect(hookResult.selectedThreadId).toBe("thread-b");
  });

  it("updates composer permission mode for the selected thread", async () => {
    vi.mocked(api.updateThreadPermissionMode).mockResolvedValue({
      ...makeThread("thread-a"),
      permissionMode: "full_access",
    });

    renderHook("thread-a");

    expect(hookResult.composerPermissionMode).toBe("default");

    await act(async () => {
      await hookResult.setComposerPermissionMode("full_access");
    });

    expect(api.updateThreadPermissionMode).toHaveBeenCalledWith("thread-a", {
      permissionMode: "full_access",
    });
    expect(hookResult.composerPermissionMode).toBe("full_access");
  });

  it("does not hit a render loop when the selected thread has no snapshot yet", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderHookInStrictMode("thread-a");

      await act(async () => {
        await Promise.resolve();
      });

      expect(
        consoleErrorSpy.mock.calls.some((call) =>
          call.some(
            (arg) => typeof arg === "string" && arg.includes("Maximum update depth exceeded"),
          ),
        ),
      ).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("clears stale stop state after session activity sync without refetching the thread list", async () => {
    threadsState.data = [makeThread("thread-a"), makeThread("thread-b", true)];

    renderHook("thread-b");

    expect(hookResult.showStopAction).toBe(true);
    expect(invalidateQueriesMock).not.toHaveBeenCalledWith({ queryKey: queryKeys.threads.list("wt-1") });

    threadsState.data = [makeThread("thread-a"), makeThread("thread-b", false)];

    renderHook("thread-b");

    await act(async () => {
      await Promise.resolve();
    });

    expect(hookResult.showStopAction).toBe(false);
  });

  it("reconciles stale running state when stop reports no active assistant run", async () => {
    threadsState.data = [makeThread("thread-a", true)];
    vi.mocked(api.stopRun).mockRejectedValue(new Error("No active assistant run for this thread"));

    renderHook("thread-a");

    expect(hookResult.showStopAction).toBe(true);

    await act(async () => {
      await hookResult.stopAssistantRun();
    });

    expect(hookResult.showStopAction).toBe(false);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot("thread-a") });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.statusSnapshot("thread-a") });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.list("wt-1") });
  });

  it("creates or reuses dedicated PR/MR thread, sends message, and invalidates repository reviews", async () => {
    vi.mocked(api.updateThreadMode).mockResolvedValue({ ...makeThread("thread-a"), mode: "plan" });
    const prMrThread = {
      ...makeThread("pr-mr-thread"),
      title: "Create Pull Request",
      kind: "review" as const,
      permissionProfile: "review_git" as const,
    };
    vi.mocked(api.getOrCreatePrMrThread).mockResolvedValue(prMrThread);
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: "message-1",
      threadId: prMrThread.id,
      seq: 1,
      role: "user",
      content: "Create PR",
      attachments: [],
      createdAt: "2026-01-01T00:00:00Z",
    });

    renderHook("thread-a", "repo-1");

    await act(async () => {
      const created = await hookResult.createOrSelectPrMrThreadAndSendMessage("Create PR");
      expect(created?.id).toBe(prMrThread.id);
    });

    expect(api.getOrCreatePrMrThread).toHaveBeenCalledWith("wt-1", {
      permissionMode: "default",
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
    });
    expect(api.sendMessage).toHaveBeenCalledWith(prMrThread.id, {
      content: "Create PR",
      mode: "default",
      attachments: [],
      expectedWorktreeId: "wt-1",
    });
    expect(hookResult.messages).toEqual([
      {
        id: "message-1",
        threadId: prMrThread.id,
        seq: 1,
        role: "user",
        content: "Create PR",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });
    expect(
      invalidateQueriesMock.mock.calls.filter(
        (call) => JSON.stringify(call[0]) === JSON.stringify({ queryKey: queryKeys.repositories.reviews("repo-1") }),
      ),
    ).toHaveLength(2);
  });

  it("waits for a pending agent selection update before sending a message", async () => {
    const selectionDeferred = createDeferred<ChatThread>();
    vi.mocked(api.updateThreadAgentSelection).mockReturnValue(selectionDeferred.promise);
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: "message-codex",
      threadId: "thread-a",
      seq: 1,
      role: "user",
      content: "Use Codex",
      attachments: [],
      createdAt: "2026-01-01T00:00:02Z",
    });

    renderHook("thread-a");

    let selectionPromise: Promise<void> | undefined;
    let submitPromise: Promise<boolean> | undefined;
    await act(async () => {
      selectionPromise = hookResult.setThreadAgentSelection("thread-a", {
        agent: "codex",
        model: "gpt-5.4",
        modelProviderId: null,
      });
      submitPromise = hookResult.submitMessage("Use Codex", "default", []);
      await Promise.resolve();
    });

    expect(api.updateThreadAgentSelection).toHaveBeenCalledWith("thread-a", {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
    });
    expect(api.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      selectionDeferred.resolve({
        ...makeThread("thread-a"),
        agent: "codex",
        model: "gpt-5.4",
        modelProviderId: null,
      });
      await Promise.resolve();
    });

    expect(api.sendMessage).toHaveBeenCalledWith("thread-a", {
      content: "Use Codex",
      mode: "default",
      attachments: [],
      expectedWorktreeId: "wt-1",
    });

    await act(async () => {
      expect(await submitPromise).toBe(true);
      await selectionPromise;
    });

    expect(hookResult.composerAgent).toBe("codex");
    expect(hookResult.composerModel).toBe("gpt-5.4");
  });

  it("waits for a pending Cursor agent selection update before sending a message", async () => {
    const selectionDeferred = createDeferred<ChatThread>();
    vi.mocked(api.updateThreadAgentSelection).mockReturnValue(selectionDeferred.promise);
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: "message-cursor",
      threadId: "thread-a",
      seq: 1,
      role: "user",
      content: "Use Cursor",
      attachments: [],
      createdAt: "2026-01-01T00:00:02Z",
    });

    renderHook("thread-a");

    let selectionPromise: Promise<void> | undefined;
    let submitPromise: Promise<boolean> | undefined;
    await act(async () => {
      selectionPromise = hookResult.setThreadAgentSelection("thread-a", {
        agent: "cursor",
        model: "default[]",
        modelProviderId: null,
      });
      submitPromise = hookResult.submitMessage("Use Cursor", "default", []);
      await Promise.resolve();
    });

    expect(api.updateThreadAgentSelection).toHaveBeenCalledWith("thread-a", {
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });
    expect(api.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      selectionDeferred.resolve({
        ...makeThread("thread-a"),
        agent: "cursor",
        model: "default[]",
        modelProviderId: null,
      });
      await Promise.resolve();
    });

    expect(api.sendMessage).toHaveBeenCalledWith("thread-a", {
      content: "Use Cursor",
      mode: "default",
      attachments: [],
      expectedWorktreeId: "wt-1",
    });

    await act(async () => {
      expect(await submitPromise).toBe(true);
      await selectionPromise;
    });

    expect(hookResult.composerAgent).toBe("cursor");
    expect(hookResult.composerModel).toBe("default[]");
  });

  it("invalidates repository reviews when closing a PR/MR thread", async () => {
    const reviewThread = {
      ...makeThread("pr-mr-thread"),
      title: "Create Pull Request",
      kind: "review" as const,
      permissionProfile: "review_git" as const,
    };
    threadsState.data = [reviewThread, makeThread("thread-b", true)];
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    renderHook("pr-mr-thread", "repo-1");

    await act(async () => {
      await hookResult.closeThread("pr-mr-thread");
    });

    expect(api.deleteThread).toHaveBeenCalledWith("pr-mr-thread");
    expect(hookResult.selectedThreadId).toBe("thread-b");
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });
  });

  it("cancels thread timeline queries before deleting the thread", async () => {
    threadsState.data = [makeThread("thread-a"), makeThread("thread-b")];
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    expect(cancelQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.timelineSnapshot("thread-a") });
    expect(cancelQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.messages("thread-a") });
    expect(cancelQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.threads.events("thread-a") });
  });

  it("does not create duplicate replacement threads while the list query is still stale and empty", async () => {
    threadsState.data = [makeThread("thread-a", true)];
    const deleteDeferred = createDeferred<void>();
    vi.mocked(api.deleteThread).mockReturnValue(deleteDeferred.promise);
    vi.mocked(api.createThread).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
    });

    renderHook("thread-a");

    await act(async () => {
      void hookResult.closeThread("thread-a");
      await Promise.resolve();
    });

    expect(api.createThread).not.toHaveBeenCalled();
    expect(hookResult.messageListEmptyState).toBe("loading-thread");

    await act(async () => {
      deleteDeferred.resolve();
      await Promise.resolve();
    });

    threadsState.data = [];
    renderHook("thread-new");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(hookResult.selectedThreadId).toBe("thread-new");

    renderHook("thread-new");

    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(hookResult.selectedThreadId).toBe("thread-new");
  });

  it("keeps the auto-created replacement thread alive across strict-mode effect replays", async () => {
    threadsState.data = [makeThread("thread-a", true)];
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);
    const firstCreateDeferred = createDeferred<ChatThread>();
    vi.mocked(api.createThread).mockReturnValue(firstCreateDeferred.promise);

    renderHookInStrictMode("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    threadsState.data = [];
    renderHookInStrictMode();

    await act(async () => {
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstCreateDeferred.resolve({
        ...makeThread("thread-new"),
        title: "New Thread",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(hookResult.selectedThreadId).toBe("thread-new");

    threadsState.data = [{ ...makeThread("thread-new"), title: "New Thread" }];
    renderHookInStrictMode("thread-new");

    expect(hookResult.threads.map((thread) => thread.id)).toEqual(["thread-new"]);
  });

  it("auto-creates a replacement thread with the last active Cursor selection", async () => {
    threadsState.data = [{
      ...makeThread("thread-a", true),
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
      cursorSessionId: "cursor-session-1",
    }];
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);
    vi.mocked(api.createThread).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    threadsState.data = [];
    renderHook();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledWith("wt-1", {
      permissionMode: "default",
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });
  });

  it("does not issue another auto-create while the replacement thread has only local state", async () => {
    threadsState.data = [makeThread("thread-a", true)];
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);
    const firstCreateDeferred = createDeferred<ChatThread>();
    vi.mocked(api.createThread).mockReturnValue(firstCreateDeferred.promise);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    threadsState.data = [];
    renderHook();

    await act(async () => {
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstCreateDeferred.resolve({
        ...makeThread("thread-new"),
        title: "New Thread",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookResult.threads.map((thread) => thread.id)).toEqual(["thread-new"]);
    expect(hookResult.selectedThreadId).toBe("thread-new");
    expect(api.createThread).toHaveBeenCalledTimes(1);

    renderHook();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);
    expect(hookResult.threads.map((thread) => thread.id)).toEqual(["thread-new"]);
  });

  it("does not issue another auto-create when the hook remounts while replacement creation is pending", async () => {
    threadsState.data = [makeThread("thread-a", true)];
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);
    const firstCreateDeferred = createDeferred<ChatThread>();
    vi.mocked(api.createThread).mockReturnValue(firstCreateDeferred.promise);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    threadsState.data = [];
    renderHook();

    await act(async () => {
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);

    renderHook();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstCreateDeferred.resolve({
        ...makeThread("thread-new"),
        title: "New Thread",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createThread).toHaveBeenCalledTimes(1);
  });

  it("restores the deleted thread when delete fails instead of creating a replacement", async () => {
    threadsState.data = [makeThread("thread-a", true)];
    const deleteDeferred = createDeferred<void>();
    vi.mocked(api.deleteThread).mockReturnValue(deleteDeferred.promise);
    vi.mocked(api.createThread).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
    });

    const onError = vi.fn();

    function ErrorHarness() {
      hookResult = useChatSession("wt-1", onError);
      return null;
    }

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ErrorHarness />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      void hookResult.closeThread("thread-a");
      await Promise.resolve();
    });

    expect(api.createThread).not.toHaveBeenCalled();

    await act(async () => {
      deleteDeferred.reject(new Error("Cannot delete thread"));
      await Promise.resolve();
    });

    expect(api.createThread).not.toHaveBeenCalled();
    expect(hookResult.selectedThreadId).toBe("thread-a");
    expect(hookResult.messageListEmptyState).toBe("loading-thread");
    expect(onError).toHaveBeenLastCalledWith("Cannot delete thread");
  });

  it("respects desiredThreadId on first render", () => {
    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-a");
  });

  it("does not auto-create a thread while the worktree thread list is still loading", async () => {
    threadsState.data = [];
    threadsState.isLoading = true;
    vi.mocked(api.createThread).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
    });

    renderHook("thread-a");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.createThread).not.toHaveBeenCalled();
    expect(hookResult.selectedThreadId).toBe("thread-a");

    threadsState.data = [makeThread("thread-a"), makeThread("thread-b", true)];
    threadsState.isLoading = false;
    renderHook("thread-a");

    expect(api.createThread).not.toHaveBeenCalled();
    expect(hookResult.selectedThreadId).toBe("thread-a");
  });

  it("syncs selection when desiredThreadId changes after mount", () => {
    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-a");

    renderHook("thread-b");

    expect(hookResult.selectedThreadId).toBe("thread-b");
  });

  it("falls back to the preferred thread when desiredThreadId becomes invalid", () => {
    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-a");

    renderHook("missing-thread");

    expect(hookResult.selectedThreadId).toBe("thread-b");
  });

  it("reselects desiredThreadId when it appears after an initial fallback", () => {
    threadsState.data = [makeThread("thread-b", true)];
    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-b");

    threadsState.data = [makeThread("thread-a"), makeThread("thread-b", true)];
    renderHook("thread-a");

    expect(hookResult.selectedThreadId).toBe("thread-a");
  });

  it("ignores desiredThreadId while it belongs to a different worktree", () => {
    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-a");

    renderHook("thread-b", null, "wt-1", "wt-2");

    expect(hookResult.selectedThreadId).toBe("thread-a");
  });

  it("reuses an existing titled thread instead of creating a duplicate", async () => {
    threadsState.data = [
      {
        ...makeThread("thread-a"),
        title: "New Thread",
      },
    ];
    vi.mocked(api.createThread).mockClear();
    vi.mocked(api.sendMessage).mockClear();
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: "message-hello",
      threadId: "thread-a",
      seq: 1,
      role: "user",
      content: "Hello",
      attachments: [],
      createdAt: "2026-01-01T00:00:00Z",
    });

    renderHook("thread-a");

    await act(async () => {
      await hookResult.createThreadAndSendMessage("New Thread", "Hello");
    });

    expect(api.createThread).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith("thread-a", {
      content: "Hello",
      mode: "default",
      attachments: [],
      expectedWorktreeId: "wt-1",
    });
  });

  it("creates a new thread with the default title", async () => {
    threadsState.data = [
      { ...makeThread("thread-a"), title: "New Thread" },
      { ...makeThread("thread-b"), title: "Investigate bug" },
    ];
    vi.mocked(api.createThread).mockClear();
    vi.mocked(api.createThread).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
    });

    renderHook("thread-a");

    await act(async () => {
      await hookResult.createAdditionalThread();
    });

    expect(api.createThread).toHaveBeenCalledWith("wt-1", {
      title: "New Thread",
      permissionMode: "default",
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
    });
  });

  it("keeps a newly created thread selected while the query list is still stale", async () => {
    threadsState.data = [makeThread("thread-a", true)];
    vi.mocked(api.createThread).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
    });

    renderHook("thread-a");

    await act(async () => {
      await hookResult.createAdditionalThread();
    });

    expect(hookResult.selectedThreadId).toBe("thread-new");

    renderHook("thread-new");

    expect(hookResult.selectedThreadId).toBe("thread-new");
    expect(hookResult.messageListEmptyState).toBe("new-thread-empty");
  });

  it("targets the newly created thread for immediate follow-up composer actions", async () => {
    threadsState.data = [{
      ...makeThread("thread-a", true),
      agent: "codex",
      model: "gpt-5.4",
    }];
    vi.mocked(api.createThread).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
      agent: "claude",
      model: "glm-4.7",
    });
    vi.mocked(api.updateThreadAgentSelection).mockResolvedValue({
      ...makeThread("thread-new"),
      title: "New Thread",
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
    });

    renderHook("thread-a");

    await act(async () => {
      await hookResult.createAdditionalThread();
      await hookResult.setComposerAgentSelection({
        agent: "codex",
        model: "gpt-5.4",
        modelProviderId: null,
      });
    });

    expect(api.updateThreadAgentSelection).toHaveBeenCalledWith("thread-new", {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
    });
    expect(hookResult.selectedThreadId).toBe("thread-new");
    expect(hookResult.composerAgent).toBe("codex");
    expect(hookResult.composerModel).toBe("gpt-5.4");
  });

  it("optimistically clears cursorSessionId when updating a Cursor thread selection", async () => {
    const selectionDeferred = createDeferred<ChatThread>();
    threadsState.data = [{
      ...makeThread("thread-a", true),
      agent: "cursor",
      model: "default[]",
      cursorSessionId: "cursor-session-1",
    }];
    vi.mocked(api.updateThreadAgentSelection).mockReturnValue(selectionDeferred.promise);

    renderHook("thread-a");

    await act(async () => {
      void hookResult.setThreadAgentSelection("thread-a", {
        agent: "cursor",
        model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        modelProviderId: null,
      });
      await Promise.resolve();
    });

    expect(hookResult.threads.find((thread) => thread.id === "thread-a")).toMatchObject({
      agent: "cursor",
      model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      cursorSessionId: null,
    });

    await act(async () => {
      selectionDeferred.resolve({
        ...makeThread("thread-a", true),
        agent: "cursor",
        model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        cursorSessionId: null,
      });
      await Promise.resolve();
    });
  });

  it("hydrates Cursor thread selection state without losing the agent or model", () => {
    threadsState.data = [{
      ...makeThread("thread-a", true),
      agent: "cursor",
      model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      cursorSessionId: "cursor-session-7",
    }];

    renderHook("thread-a");

    expect(hookResult.composerAgent).toBe("cursor");
    expect(hookResult.composerModel).toBe("gpt-5.4[context=272k,reasoning=medium,fast=false]");
    expect(hookResult.threads[0]).toMatchObject({
      agent: "cursor",
      model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      cursorSessionId: "cursor-session-7",
    });
  });

  it("marks a requested thread as loading while selection bootstrap is unresolved", () => {
    threadsState.data = undefined;

    renderHook("thread-a");

    expect(hookResult.messageListEmptyState).toBe("loading-thread");
  });

  it("marks an existing thread as loading while its snapshot is still fetching", () => {
    snapshotState.isLoading = true;
    snapshotState.isFetching = true;

    renderHook("thread-a");

    expect(hookResult.messageListEmptyState).toBe("loading-thread");
  });

  it("marks an existing selected thread as loading while snapshot bootstrap is unresolved", () => {
    renderHook("thread-a");

    expect(hookResult.selectedThreadId).toBe("thread-a");
    expect(hookResult.messageListEmptyState).toBe("loading-thread");
  });

  it("marks an empty fetched thread as empty instead of loading", () => {
    snapshotState.data = makeSnapshot();

    renderHook("thread-a");

    expect(hookResult.messageListEmptyState).toBe("existing-thread-empty");
  });

  it("emits thread navigation perf stages while bootstrapping a populated thread", async () => {
    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      timelineItems: [{
        kind: "message",
        message: {
          id: "assistant-1",
          threadId: "thread-a",
          seq: 1,
          role: "assistant",
          content: "Canonical answer",
          attachments: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
        renderHint: "markdown",
        isCompleted: true,
        context: [],
      }],
      summary: {
        oldestRenderableKey: "message:assistant-1",
        oldestRenderableKind: "message",
        oldestRenderableMessageId: "assistant-1",
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Canonical answer",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });

    renderHook("thread-a");

    await act(async () => {
      await Promise.resolve();
    });

    const events = pushThreadNavigationPerfMock.mock.calls.map(([entry]) => entry.event);
    expect(events).toEqual(expect.arrayContaining([
      "selection.start",
      "snapshot.received",
      "snapshot.hydrated",
      "thread.ready",
    ]));
  });

  it("skips thread navigation perf instrumentation when perf debug is disabled", async () => {
    threadNavigationPerfEnabledState.value = false;
    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Canonical answer",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });

    renderHook("thread-a");

    await act(async () => {
      await Promise.resolve();
    });

    expect(pushThreadNavigationPerfMock).not.toHaveBeenCalled();
  });

  it("uses the authoritative server timeline during bootstrap when the snapshot contains canonical messages", () => {
    const serverTimelineItems: ChatTimelineItem[] = [
      {
        kind: "message",
        message: {
          id: "assistant-1",
          threadId: "thread-a",
          seq: 1,
          role: "assistant",
          content: "Canonical answer",
          attachments: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
        renderHint: "markdown",
        isCompleted: true,
        context: [],
      },
    ];

    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      timelineItems: serverTimelineItems as ChatTimelineSnapshot["timelineItems"],
      summary: {
        oldestRenderableKey: "message:assistant-1",
        oldestRenderableKind: "message",
        oldestRenderableMessageId: "assistant-1",
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Canonical answer",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });

    useWorkspaceTimelineMock.mockReturnValue({
      items: [],
      summary: {
        oldestRenderableKey: null,
        oldestRenderableKind: null,
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
    });

    renderHook("thread-a");

    expect(hookResult.timelineItems).toEqual(serverTimelineItems);
  });

  it("uses display timeline snapshots even before full hydration data arrives", () => {
    const staleServerItems: ChatTimelineItem[] = [
      {
        kind: "edited-diff",
        id: "stale-edited",
        eventId: "event-1",
        status: "success",
        diffKind: "proposed",
        changedFiles: ["src/app.ts"],
        diff: "",
        diffTruncated: false,
        additions: 1,
        deletions: 1,
        rejectedByUser: false,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    snapshotState.data = makeSnapshot({
      collectionsIncluded: false,
      timelineItems: staleServerItems as ChatTimelineSnapshot["timelineItems"],
      summary: {
        oldestRenderableKey: "edited-diff:stale-edited",
        oldestRenderableKind: "edited-diff",
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
    });

    useWorkspaceTimelineMock.mockReturnValue({
      items: [],
      summary: {
        oldestRenderableKey: null,
        oldestRenderableKind: null,
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
    });

    renderHook("thread-a");

    expect(hookResult.timelineItems).toEqual(staleServerItems);
  });

  it("replaces stale local messages and events when the latest snapshot for the same thread is empty", () => {
    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      messages: [{
        id: "msg-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "old content",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "msg-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });

    renderHook("thread-a");
    expect(hookResult.messages).toHaveLength(1);
    expect(hookResult.events).toHaveLength(1);

    snapshotState.data = makeSnapshot();
    renderHook("thread-a");

    expect(hookResult.messages).toEqual([]);
    expect(hookResult.events).toEqual([]);
  });

  it("replaces corrupted local assistant output with the final authoritative snapshot once the thread is idle", async () => {
    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Flow canonical.",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });

    renderHook("thread-a");
    expect(hookResult.messages[0]?.content).toBe("Flow canonical.");
    expect(hookResult.selectedThreadUiStatus).toBe("idle");

    act(() => {
      const { messagesCollection, eventsCollection } = getThreadCollections("thread-a");
      messagesCollection.update("assistant-1", (draft) => {
        draft.content = "Flow canonical. Flow canonical. Flow canonical with duplicated streamed text.";
      });
      eventsCollection.insert({
        id: "event-local-stale",
        threadId: "thread-a",
        idx: 2,
        type: "tool.finished",
        payload: {
          toolName: "Read",
          summary: "Read stale-local.txt",
          precedingToolUseIds: ["read-local-1"],
        },
        createdAt: "2026-01-01T00:00:02Z",
      });
      setThreadLastMessageSeq("thread-a", 1);
      setThreadLastEventIdx("thread-a", 2);
    });

    expect(hookResult.messages[0]?.content).toContain("duplicated streamed text");
    expect(hookResult.events.map((event) => event.id)).toContain("event-local-stale");

    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 3,
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Flow canonical.",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [
        {
          id: "event-1",
          threadId: "thread-a",
          idx: 1,
          type: "chat.completed",
          payload: { messageId: "assistant-1" },
          createdAt: "2026-01-01T00:00:01Z",
        },
        {
          id: "event-3",
          threadId: "thread-a",
          idx: 3,
          type: "tool.finished",
          payload: {
            toolName: "Read",
            summary: "Read canonical.txt",
            precedingToolUseIds: ["read-final-1"],
          },
          createdAt: "2026-01-01T00:00:03Z",
        },
      ],
    });

    renderHook("thread-a");
    await act(async () => {
      await Promise.resolve();
    });

    expect(hookResult.messages).toEqual([
      {
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Flow canonical.",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(hookResult.events.map((event) => event.id)).toEqual(["event-1", "event-3"]);
  });

  it("prefers a fresh authoritative server timeline while idle even when derived local timeline drifts", async () => {
    const serverTimelineItems: ChatTimelineItem[] = [
      {
        kind: "explore-activity",
        id: "explore-1",
        status: "success",
        fileCount: 1,
        searchCount: 0,
        entries: [
          {
            kind: "read",
            label: "src/foo.ts",
            openPath: "src/foo.ts",
            pending: false,
            orderIdx: 0,
          },
        ],
      },
      {
        kind: "message",
        message: {
          id: "assistant-1",
          threadId: "thread-a",
          seq: 1,
          role: "assistant",
          content: "Canonical answer",
          attachments: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
        renderHint: "markdown",
        isCompleted: true,
        context: [],
      },
    ];

    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      timelineItems: serverTimelineItems as ChatTimelineSnapshot["timelineItems"],
      summary: {
        oldestRenderableKey: "explore-activity:explore-1",
        oldestRenderableKind: "explore-activity",
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Canonical answer",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });

    useWorkspaceTimelineMock.mockReturnValue({
      items: [
        {
          kind: "message",
          message: {
            id: "assistant-1:segment:0",
            threadId: "thread-a",
            seq: 1,
            role: "assistant",
            content: "Corrupted local order",
            attachments: [],
            createdAt: "2026-01-01T00:00:00Z",
          },
          renderHint: "markdown",
          isCompleted: true,
          context: [],
        },
      ] as ChatTimelineItem[],
      summary: {
        oldestRenderableKey: "message:assistant-1:segment:0",
        oldestRenderableKind: "message",
        oldestRenderableMessageId: "assistant-1:segment:0",
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
    } as any);

    renderHook("thread-a");
    expect(hookResult.timelineItems).toEqual(serverTimelineItems);

    act(() => {
      const { messagesCollection } = getThreadCollections("thread-a");
      messagesCollection.update("assistant-1", (draft) => {
        draft.content = "Locally corrupted but not ahead";
      });
      setThreadLastMessageSeq("thread-a", 1);
      setThreadLastEventIdx("thread-a", 1);
    });

    renderHook("thread-a");

    expect(hookResult.selectedThreadUiStatus).toBe("idle");
    expect(hookResult.timelineItems).toEqual(serverTimelineItems);
  });

  it("shows a submitted follow-up user message immediately from the send response", async () => {
    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Initial reply",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: "user-2",
      threadId: "thread-a",
      seq: 2,
      role: "user",
      content: "Follow up",
      attachments: [],
      createdAt: "2026-01-01T00:00:02Z",
    });

    renderHook("thread-a");
    expect(hookResult.messages.map((message) => message.id)).toEqual(["assistant-1"]);

    await act(async () => {
      const submitted = await hookResult.submitMessage("Follow up", "default", []);
      expect(submitted).toBe(true);
    });

    expect(hookResult.messages).toEqual([
      {
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Initial reply",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "user-2",
        threadId: "thread-a",
        seq: 2,
        role: "user",
        content: "Follow up",
        attachments: [],
        createdAt: "2026-01-01T00:00:02Z",
      },
    ]);
  });

  it("shows an optimistic follow-up user message before the send response resolves", async () => {
    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Initial reply",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });
    const sendDeferred = createDeferred<ChatMessage>();
    vi.mocked(api.sendMessage).mockReturnValue(sendDeferred.promise);

    renderHook("thread-a");

    let submitPromise: Promise<boolean> | undefined;
    await act(async () => {
      submitPromise = hookResult.submitMessage("Follow up", "default", []);
      await Promise.resolve();
    });

    expect(hookResult.messages).toEqual([
      {
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Initial reply",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      expect.objectContaining({
        id: expect.stringMatching(/^optimistic-user:thread-a:/),
        threadId: "thread-a",
        seq: 2,
        role: "user",
        content: "Follow up",
        attachments: [],
      }),
    ]);

    await act(async () => {
      sendDeferred.resolve({
        id: "user-2",
        threadId: "thread-a",
        seq: 2,
        role: "user",
        content: "Follow up",
        attachments: [],
        createdAt: "2026-01-01T00:00:02Z",
      });
      const submitted = await submitPromise;
      expect(submitted).toBe(true);
    });

    expect(hookResult.messages).toEqual([
      {
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Initial reply",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "user-2",
        threadId: "thread-a",
        seq: 2,
        role: "user",
        content: "Follow up",
        attachments: [],
        createdAt: "2026-01-01T00:00:02Z",
      },
    ]);
  });

  it("does not let a stale snapshot hide a newly submitted user message while waiting for assistant output", async () => {
    snapshotState.data = makeSnapshot({
      newestSeq: 1,
      newestIdx: 1,
      messages: [{
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Initial reply",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      }],
      events: [{
        id: "event-1",
        threadId: "thread-a",
        idx: 1,
        type: "chat.completed",
        payload: { messageId: "assistant-1" },
        createdAt: "2026-01-01T00:00:01Z",
      }],
    });
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: "user-2",
      threadId: "thread-a",
      seq: 2,
      role: "user",
      content: "Follow up",
      attachments: [],
      createdAt: "2026-01-01T00:00:02Z",
    });

    renderHook("thread-a");

    await act(async () => {
      const submitted = await hookResult.submitMessage("Follow up", "default", []);
      expect(submitted).toBe(true);
    });

    snapshotState.data = makeSnapshot({
      summary: {
        oldestRenderableKey: "server-stale",
        oldestRenderableKind: "activity",
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: false,
      },
    });
    renderHook("thread-a");

    expect(hookResult.messages).toEqual([
      {
        id: "assistant-1",
        threadId: "thread-a",
        seq: 1,
        role: "assistant",
        content: "Initial reply",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "user-2",
        threadId: "thread-a",
        seq: 2,
        role: "user",
        content: "Follow up",
        attachments: [],
        createdAt: "2026-01-01T00:00:02Z",
      },
    ]);
  });
});
