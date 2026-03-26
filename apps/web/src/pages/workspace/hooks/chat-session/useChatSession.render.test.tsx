import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, ChatTimelineSnapshot } from "@codesymphony/shared-types";
import { ApiError, api } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/queryKeys";
import { useChatSession } from "./useChatSession";

const { threadsState, snapshotState } = vi.hoisted(() => ({
  threadsState: {
    data: [] as ChatThread[],
  },
  snapshotState: {
    data: null as ChatTimelineSnapshot | null,
  },
}));

vi.mock("../../../../hooks/queries/useThreads", () => ({
  useThreads: vi.fn(() => ({ data: threadsState.data })),
}));

vi.mock("../../../../hooks/queries/useThreadSnapshot", () => ({
  useThreadSnapshot: vi.fn(() => ({ data: snapshotState.data })),
}));

vi.mock("./useThreadEventStream", () => ({
  useThreadEventStream: vi.fn(),
}));

vi.mock("../workspace-timeline", () => ({
  useWorkspaceTimeline: vi.fn(() => ({
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

vi.mock("../../../../lib/renderDebug", () => ({
  pushRenderDebug: vi.fn(),
}));

vi.mock("../../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/api")>();
  return {
    ...actual,
    api: {
      createThread: vi.fn(),
      getOrCreatePrMrThread: vi.fn(),
      getThread: vi.fn(),
      renameThreadTitle: vi.fn(),
      deleteThread: vi.fn(),
      sendMessage: vi.fn(),
      stopRun: vi.fn(),
    },
  };
});

const invalidateQueriesMock = vi.fn();

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

beforeEach(() => {
  threadsState.data = [makeThread("thread-a"), makeThread("thread-b", true)];
  snapshotState.data = null;
  vi.mocked(api.createThread).mockReset();
  vi.mocked(api.getOrCreatePrMrThread).mockReset();
  vi.mocked(api.getThread).mockReset();
  vi.mocked(api.renameThreadTitle).mockReset();
  vi.mocked(api.deleteThread).mockReset();
  vi.mocked(api.sendMessage).mockReset();
  vi.mocked(api.stopRun).mockReset();
  vi.mocked(api.getThread).mockImplementation(async (threadId: string) => threadsState.data.find((thread) => thread.id === threadId)!);
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
  queryClient.invalidateQueries = invalidateQueriesMock as typeof queryClient.invalidateQueries;
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("useChatSession", () => {
  it("creates or reuses dedicated review thread, sends message, and invalidates repository reviews", async () => {
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

    expect(api.getOrCreatePrMrThread).toHaveBeenCalledWith("wt-1");
    expect(api.sendMessage).toHaveBeenCalledWith(prMrThread.id, {
      content: "Create PR",
      mode: "default",
      attachments: [],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });
    expect(
      invalidateQueriesMock.mock.calls.filter(
        (call) => JSON.stringify(call[0]) === JSON.stringify({ queryKey: queryKeys.repositories.reviews("repo-1") }),
      ),
    ).toHaveLength(2);
  });

  it("invalidates repository reviews when closing a review thread", async () => {
    const reviewThread = {
      ...makeThread("pr-mr-thread"),
      title: "Create Pull Request",
      kind: "review" as const,
      permissionProfile: "review_git" as const,
      active: false,
    };
    threadsState.data = [reviewThread, makeThread("thread-b", true)];
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    renderHook("pr-mr-thread", "repo-1");

    await act(async () => {
      await hookResult.closeThread("pr-mr-thread");
    });

    expect(api.stopRun).not.toHaveBeenCalled();
    expect(api.deleteThread).toHaveBeenCalledWith("pr-mr-thread", undefined);
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: queryKeys.repositories.reviews("repo-1") });
  });

  it("respects desiredThreadId on first render", () => {
    renderHook("thread-a");
    expect(hookResult.selectedThreadId).toBe("thread-a");
  });

  it("derives ACP available commands from command update events", () => {
    snapshotState.data = {
      timelineItems: [],
      summary: {
        oldestRenderableKey: null,
        oldestRenderableKind: null,
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
      newestSeq: 0,
      newestIdx: 1,
      messages: [],
      events: [{
        id: "evt-1",
        threadId: "thread-a",
        idx: 1,
        type: "commands.updated",
        payload: {
          availableCommands: [
            { name: "commit", description: "Create a git commit", input: { hint: "-m 'msg'" } },
          ],
        },
        createdAt: "2026-01-01T00:00:00Z",
      }],
    };

    renderHook("thread-a");

    expect(hookResult.availableCommands).toEqual([
      { name: "commit", description: "Create a git commit", input: { hint: "-m 'msg'" } },
    ]);
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

  it("creates a replacement thread before removing the last thread", async () => {
    threadsState.data = [makeThread("solo-thread")];
    vi.mocked(api.createThread).mockResolvedValue(makeThread("replacement-thread"));
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    renderHook("solo-thread");

    await act(async () => {
      await hookResult.closeThread("solo-thread");
    });

    expect(api.createThread).toHaveBeenCalledWith("wt-1", { title: "New Thread" });
    expect(api.deleteThread).toHaveBeenCalledWith("solo-thread", undefined);
    expect(hookResult.selectedThreadId).toBe("replacement-thread");
    expect(hookResult.threads.map((thread) => thread.id)).toEqual(["replacement-thread"]);

    renderHook("solo-thread");

    expect(hookResult.selectedThreadId).toBe("replacement-thread");
    expect(hookResult.threads.map((thread) => thread.id)).toEqual(["replacement-thread"]);
  });

  it("keeps a newly created thread selected and appended while query data is stale", async () => {
    vi.mocked(api.createThread).mockResolvedValue(makeThread("thread-c"));

    renderHook("thread-b");

    await act(async () => {
      await hookResult.createAdditionalThread();
    });

    expect(api.createThread).toHaveBeenCalledWith("wt-1", { title: "New Thread" });
    expect(hookResult.selectedThreadId).toBe("thread-c");
    expect(hookResult.threads.map((thread) => thread.id)).toEqual(["thread-a", "thread-b", "thread-c"]);

    renderHook("thread-b");

    expect(hookResult.selectedThreadId).toBe("thread-c");
    expect(hookResult.threads.map((thread) => thread.id)).toEqual(["thread-a", "thread-b", "thread-c"]);
  });

  it("retries delete after stop when the first delete sees an active conflict", async () => {
    threadsState.data = [makeThread("thread-a", true), makeThread("thread-b")];
    vi.mocked(api.stopRun).mockResolvedValue(undefined);
    vi.mocked(api.deleteThread)
      .mockRejectedValueOnce(new ApiError("Cannot delete a thread while assistant is processing", 409))
      .mockResolvedValueOnce(undefined);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    expect(api.stopRun).toHaveBeenCalledWith("thread-a");
    expect(api.deleteThread).toHaveBeenCalledTimes(2);
    expect(hookResult.selectedThreadId).toBe("thread-b");
  });

  it("retries forced close without polling thread status", async () => {
    threadsState.data = [makeThread("thread-a", true), makeThread("thread-b")];
    vi.mocked(api.stopRun).mockResolvedValue(undefined);
    vi.mocked(api.deleteThread)
      .mockRejectedValueOnce(new ApiError("Cannot delete a thread while assistant is processing", 409))
      .mockResolvedValueOnce(undefined);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a", { force: true });
    });

    expect(api.stopRun).toHaveBeenCalledWith("thread-a");
    expect(api.getThread).not.toHaveBeenCalled();
    expect(api.deleteThread).toHaveBeenCalledTimes(2);
  });

  it("stops before the first delete attempt during forced close", async () => {
    threadsState.data = [makeThread("thread-a", false), makeThread("thread-b")];
    vi.mocked(api.stopRun).mockResolvedValue(undefined);
    vi.mocked(api.getThread).mockResolvedValue(makeThread("thread-a", false));
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a", { force: true });
    });

    expect(api.stopRun).toHaveBeenCalledWith("thread-a");
    expect(api.deleteThread).toHaveBeenCalledWith("thread-a", { force: true });
    expect(vi.mocked(api.stopRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.deleteThread).mock.invocationCallOrder[0],
    );
  });

  it("stops again after 409 before second delete attempt", async () => {
    threadsState.data = [makeThread("thread-a", false), makeThread("thread-b")];
    vi.mocked(api.stopRun).mockResolvedValue(undefined);
    vi.mocked(api.deleteThread)
      .mockRejectedValueOnce(new ApiError("Cannot delete a thread while assistant is processing", 409))
      .mockResolvedValueOnce(undefined);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    expect(api.stopRun).toHaveBeenCalledTimes(1);
    expect(api.stopRun).toHaveBeenLastCalledWith("thread-a");
    expect(api.deleteThread).toHaveBeenCalledTimes(2);
  });

  it("retries delete multiple times when active conflict persists", async () => {
    threadsState.data = [makeThread("thread-a", false), makeThread("thread-b")];
    vi.mocked(api.stopRun).mockResolvedValue(undefined);
    vi.mocked(api.deleteThread)
      .mockRejectedValueOnce(new ApiError("Cannot delete a thread while assistant is processing", 409))
      .mockRejectedValueOnce(new ApiError("Cannot delete a thread while assistant is processing", 409))
      .mockRejectedValueOnce(new ApiError("Cannot delete a thread while assistant is processing", 409))
      .mockResolvedValueOnce(undefined);

    renderHook("thread-a");

    await act(async () => {
      await hookResult.closeThread("thread-a");
    });

    expect(api.stopRun).toHaveBeenCalledTimes(3);
    expect(api.deleteThread).toHaveBeenCalledTimes(4);
  });
});
