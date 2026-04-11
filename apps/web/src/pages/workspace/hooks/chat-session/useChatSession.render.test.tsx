import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, ChatTimelineItem, ChatTimelineSnapshot } from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/queryKeys";
import { useChatSession } from "./useChatSession";

const { threadsState, snapshotState } = vi.hoisted(() => ({
  threadsState: {
    data: [] as ChatThread[],
  },
  snapshotState: {
    data: null as ChatTimelineSnapshot | null,
    isLoading: false,
    isFetching: false,
  },
}));

vi.mock("../../../../hooks/queries/useThreads", () => ({
  useThreads: vi.fn(() => ({ data: threadsState.data })),
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

vi.mock("../../../../lib/renderDebug", () => ({
  pushRenderDebug: vi.fn(),
}));

vi.mock("../../../../lib/api", () => ({
  api: {
    createThread: vi.fn(),
    getOrCreatePrMrThread: vi.fn(),
    renameThreadTitle: vi.fn(),
    updateThreadMode: vi.fn(),
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
    claudeSessionId: null,
    active,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function HookHarness({ desiredThreadId, repositoryId = null }: { desiredThreadId?: string; repositoryId?: string | null }) {
  hookResult = useChatSession("wt-1", vi.fn(), undefined, {
    desiredThreadId,
    repositoryId,
  });
  return null;
}

function renderHook(desiredThreadId?: string, repositoryId?: string | null) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness desiredThreadId={desiredThreadId} repositoryId={repositoryId} />
      </QueryClientProvider>,
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
  threadsState.data = [makeThread("thread-a"), makeThread("thread-b", true)];
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
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
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

    expect(api.getOrCreatePrMrThread).toHaveBeenCalledWith("wt-1", { permissionMode: "default" });
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

  it("respects desiredThreadId on first render", () => {
    renderHook("thread-a");
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

  it("marks an existing thread as loading while its snapshot is still fetching", () => {
    snapshotState.isLoading = true;
    snapshotState.isFetching = true;

    renderHook("thread-a");

    expect(hookResult.messageListEmptyState).toBe("loading-thread");
  });

  it("marks an empty fetched thread as empty instead of loading", () => {
    snapshotState.data = makeSnapshot();

    renderHook("thread-a");

    expect(hookResult.messageListEmptyState).toBe("existing-thread-empty");
  });

  it("prefers derived timeline when server snapshot contains stale cards but derived timeline is empty", () => {
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

    expect(hookResult.timelineItems).toEqual([]);
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
