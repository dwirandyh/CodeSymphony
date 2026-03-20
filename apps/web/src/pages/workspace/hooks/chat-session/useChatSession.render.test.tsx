import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, ChatTimelineSnapshot } from "@codesymphony/shared-types";
import { api } from "../../../../lib/api";
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

vi.mock("../../../../lib/api", () => ({
  api: {
    createThread: vi.fn(),
    getOrCreatePrMrThread: vi.fn(),
    renameThreadTitle: vi.fn(),
    deleteThread: vi.fn(),
    sendMessage: vi.fn(),
    stopRun: vi.fn(),
  },
}));

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

function HookHarness({ desiredThreadId }: { desiredThreadId?: string }) {
  hookResult = useChatSession("wt-1", vi.fn(), undefined, {
    desiredThreadId,
  });
  return null;
}

function renderHook(desiredThreadId?: string) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness desiredThreadId={desiredThreadId} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  threadsState.data = [makeThread("thread-a"), makeThread("thread-b", true)];
  snapshotState.data = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("useChatSession", () => {
  it("creates or reuses dedicated PR/MR thread and sends message", async () => {
    const prMrThread = {
      ...makeThread("pr-mr-thread"),
      title: "PR / MR",
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

    renderHook("thread-a");

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
});
