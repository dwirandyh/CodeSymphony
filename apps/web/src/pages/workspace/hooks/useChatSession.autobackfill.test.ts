import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatThread, ChatThreadSnapshot } from "@codesymphony/shared-types";

const useThreadsMock = vi.fn();
const useThreadSnapshotMock = vi.fn();
const useWorkspaceTimelineMock = vi.fn();

const listEventsPageMock = vi.fn();
const listMessagesPageMock = vi.fn();
const getThreadSnapshotMock = vi.fn();
const createThreadMock = vi.fn();
const createRepositoryThreadMock = vi.fn();
const sendMessageMock = vi.fn();
const deleteThreadMock = vi.fn();
const renameThreadTitleMock = vi.fn();
const stopRunMock = vi.fn();

vi.mock("../../../hooks/queries/useThreads", () => ({
  useThreads: (...args: unknown[]) => useThreadsMock(...args),
}));

vi.mock("../../../hooks/queries/useThreadSnapshot", () => ({
  useThreadSnapshot: (...args: unknown[]) => useThreadSnapshotMock(...args),
}));

vi.mock("./useWorkspaceTimeline", () => ({
  useWorkspaceTimeline: (...args: unknown[]) => useWorkspaceTimelineMock(...args),
}));

vi.mock("../../../lib/api", () => ({
  api: {
    runtimeBaseUrl: "http://localhost:4331",
    listEventsPage: (...args: unknown[]) => listEventsPageMock(...args),
    listMessagesPage: (...args: unknown[]) => listMessagesPageMock(...args),
    getThreadSnapshot: (...args: unknown[]) => getThreadSnapshotMock(...args),
    createThread: (...args: unknown[]) => createThreadMock(...args),
    createRepositoryThread: (...args: unknown[]) => createRepositoryThreadMock(...args),
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
    deleteThread: (...args: unknown[]) => deleteThreadMock(...args),
    renameThreadTitle: (...args: unknown[]) => renameThreadTitleMock(...args),
    stopRun: (...args: unknown[]) => stopRunMock(...args),
  },
}));

import { useChatSession } from "./useChatSession";

function makeThread(): ChatThread {
  return {
    id: "thread-1",
    worktreeId: "wt-1",
    title: "Thread 1",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  };
}

function makeEvent(idx: number): ChatEvent {
  return {
    id: `event-${idx}`,
    threadId: "thread-1",
    idx,
    type: "chat.completed",
    payload: { messageId: "msg-1" },
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

function makeSnapshot(params: {
  eventsStatus: "complete" | "needs_backfill" | "capped";
  recommendedBackfill: boolean;
  nextBeforeIdx: number | null;
  hasMoreOlderEvents: boolean;
}): ChatThreadSnapshot {
  return {
    messages: {
      data: [
        {
          id: "msg-1",
          threadId: "thread-1",
          seq: 1,
          role: "assistant",
          content: "hello",
          attachments: [],
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: 1,
        newestSeq: 1,
      },
    },
    events: {
      data: [makeEvent(1000)],
      pageInfo: {
        hasMoreOlder: params.hasMoreOlderEvents,
        nextBeforeIdx: params.nextBeforeIdx,
        oldestIdx: params.nextBeforeIdx,
        newestIdx: 1000,
      },
    },
    watermarks: {
      newestSeq: 1,
      newestIdx: 1000,
    },
    coverage: {
      eventsStatus: params.eventsStatus,
      recommendedBackfill: params.recommendedBackfill,
      nextBeforeIdx: params.nextBeforeIdx,
    },
  };
}

type HookHarnessProps = {
  onResult: (result: ReturnType<typeof useChatSession>) => void;
};

function HookHarness({ onResult }: HookHarnessProps) {
  const result = useChatSession(
    "wt-1",
    () => {
      // noop for test
    },
    undefined,
    { initialThreadId: "thread-1" },
  );
  onResult(result);
  return null;
}

async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("useChatSession auto-backfill reseed regression", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let originalEventSource: unknown;

  beforeEach(() => {
    class MockEventSource {
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      close = vi.fn(() => {
        this.readyState = 2;
      });

      constructor(_url: string) {
        // noop
      }
    }

    originalEventSource = globalThis.EventSource;
    (globalThis as { EventSource: unknown }).EventSource = MockEventSource as unknown;

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

    useThreadsMock.mockReset();
    useThreadSnapshotMock.mockReset();
    useWorkspaceTimelineMock.mockReset();
    listEventsPageMock.mockReset();
    listMessagesPageMock.mockReset();
    getThreadSnapshotMock.mockReset();
    createThreadMock.mockReset();
    createRepositoryThreadMock.mockReset();
    sendMessageMock.mockReset();
    deleteThreadMock.mockReset();
    renameThreadTitleMock.mockReset();
    stopRunMock.mockReset();

    useThreadsMock.mockReturnValue({ data: [makeThread()] });
    useWorkspaceTimelineMock.mockReturnValue({ items: [], hasIncompleteCoverage: false });

    listMessagesPageMock.mockResolvedValue({
      data: [],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: null,
        newestSeq: null,
      },
    });

    listEventsPageMock.mockResolvedValue({
      data: [makeEvent(500)],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeIdx: null,
        oldestIdx: 500,
        newestIdx: 500,
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    queryClient.clear();
    (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  });

  it("auto-backfills when same-thread snapshot reseed changes to needs_backfill", async () => {
    const snapshotComplete = makeSnapshot({
      eventsStatus: "complete",
      recommendedBackfill: false,
      nextBeforeIdx: null,
      hasMoreOlderEvents: false,
    });

    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 500,
      hasMoreOlderEvents: true,
    });

    let currentSnapshot: ChatThreadSnapshot = snapshotComplete;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    let latestResult: ReturnType<typeof useChatSession> | undefined;

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: (result) => {
                latestResult = result;
              },
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks();

    if (!latestResult) {
      throw new Error("Expected useChatSession result");
    }

    expect(latestResult.selectedThreadId).toBe("thread-1");
    expect(listEventsPageMock).not.toHaveBeenCalled();

    currentSnapshot = snapshotNeedsBackfill;
    renderHarness();
    await flushMicrotasks(5);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);
    expect(listEventsPageMock).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ beforeIdx: 500 }),
    );
  });
});
