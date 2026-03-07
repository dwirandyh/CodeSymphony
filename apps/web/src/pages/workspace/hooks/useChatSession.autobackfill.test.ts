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

vi.mock("./workspace-timeline", () => ({
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

import { useChatSession, resolveHydrationBackfillPolicy } from "./chat-session";

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

function makeEvent(
  idx: number,
  overrides?: Partial<Pick<ChatEvent, "type" | "payload">>,
): ChatEvent {
  return {
    id: `event-${idx}`,
    threadId: "thread-1",
    idx,
    type: overrides?.type ?? "chat.completed",
    payload: overrides?.payload ?? { messageId: "msg-1" },
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

function makeSnapshot(params: {
  eventsStatus: "complete" | "needs_backfill" | "capped";
  recommendedBackfill: boolean;
  nextBeforeIdx: number | null;
  hasMoreOlderEvents: boolean;
  newestIdx?: number;
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
      data: [makeEvent(params.newestIdx ?? 1000)],
      pageInfo: {
        hasMoreOlder: params.hasMoreOlderEvents,
        nextBeforeIdx: params.nextBeforeIdx,
        oldestIdx: params.nextBeforeIdx,
        newestIdx: params.newestIdx ?? 1000,
      },
    },
    watermarks: {
      newestSeq: 1,
      newestIdx: params.newestIdx ?? 1000,
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
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void;
  hydrationBackfillPolicy?: "manual" | "auto";
};

function HookHarness({ onResult, onBranchRenamed, hydrationBackfillPolicy }: HookHarnessProps) {
  const result = useChatSession(
    "wt-1",
    () => {
      // noop for test
    },
    onBranchRenamed,
    { initialThreadId: "thread-1", hydrationBackfillPolicy },
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
  it("defaults hydration policy to manual and does not auto-load older pages on mount", async () => {
    expect(resolveHydrationBackfillPolicy(undefined)).toBe("manual");

    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 500,
      hasMoreOlderEvents: true,
    });

    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? snapshotNeedsBackfill : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => snapshotNeedsBackfill);

    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(HookHarness, {
            onResult: () => {
              // noop
            },
          }),
        ),
      );
    });

    await flushMicrotasks(6);

    expect(listEventsPageMock).not.toHaveBeenCalled();
    expect(listMessagesPageMock).not.toHaveBeenCalled();
  });

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
    useWorkspaceTimelineMock.mockReturnValue({
      items: [],
      hasIncompleteCoverage: false,
      summary: {
        oldestRenderableKey: null,
        oldestRenderableKind: null,
        oldestRenderableMessageId: null,
        oldestRenderableHydrationPending: false,
        headIdentityStable: true,
      },
    });

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

  it("does not relaunch auto-backfill for same launch key", async () => {
    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 80,
      hasMoreOlderEvents: true,
    });

    let currentSnapshot: ChatThreadSnapshot = snapshotNeedsBackfill;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: () => {
                // noop
              },
              hydrationBackfillPolicy: "auto",
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks(6);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);

    renderHarness();
    await flushMicrotasks(6);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch same launch key after productive abort", async () => {
    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 80,
      hasMoreOlderEvents: true,
    });

    let currentSnapshot: ChatThreadSnapshot = snapshotNeedsBackfill;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    let resolveFirstEventsPage: ((value: {
      data: ChatEvent[];
      pageInfo: {
        hasMoreOlder: boolean;
        nextBeforeIdx: number | null;
        oldestIdx: number | null;
        newestIdx: number | null;
      };
    }) => void) | null = null;

    listMessagesPageMock.mockResolvedValue({
      data: [],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: null,
        newestSeq: null,
      },
    });

    listEventsPageMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveFirstEventsPage = resolve;
      }),
    );

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: () => {
                // noop
              },
              hydrationBackfillPolicy: "auto",
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks(5);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);

    currentSnapshot = {
      ...snapshotNeedsBackfill,
      messages: {
        ...snapshotNeedsBackfill.messages,
        data: [...snapshotNeedsBackfill.messages.data],
      },
      events: {
        ...snapshotNeedsBackfill.events,
        data: [...snapshotNeedsBackfill.events.data],
      },
      watermarks: { ...snapshotNeedsBackfill.watermarks },
      coverage: { ...snapshotNeedsBackfill.coverage },
    };

    renderHarness();
    await flushMicrotasks(2);

    if (!resolveFirstEventsPage) {
      throw new Error("Expected deferred events page resolver");
    }

    await act(async () => {
      resolveFirstEventsPage?.({
        data: [makeEvent(70)],
        pageInfo: {
          hasMoreOlder: true,
          nextBeforeIdx: 70,
          oldestIdx: 70,
          newestIdx: 70,
        },
      });
      await Promise.resolve();
    });

    await flushMicrotasks(6);

    renderHarness();
    await flushMicrotasks(4);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);
  });

  it("relaunches auto-backfill when snapshot key changes", async () => {
    const snapshotA = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 80,
      hasMoreOlderEvents: true,
    });

    const snapshotB = {
      ...makeSnapshot({
        eventsStatus: "needs_backfill",
        recommendedBackfill: true,
        nextBeforeIdx: 60,
        hasMoreOlderEvents: true,
      }),
      watermarks: {
        newestSeq: 2,
        newestIdx: 1200,
      },
    } satisfies ChatThreadSnapshot;

    let currentSnapshot: ChatThreadSnapshot = snapshotA;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: () => {
                // noop
              },
              hydrationBackfillPolicy: "auto",
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks(6);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);

    currentSnapshot = snapshotB;
    renderHarness();
    await flushMicrotasks(6);

    expect(listEventsPageMock).toHaveBeenCalledTimes(2);
    expect(listEventsPageMock).toHaveBeenLastCalledWith(
      "thread-1",
      expect.objectContaining({ beforeIdx: 60 }),
    );
  });

  it("stops and does not reenter when cursor makes no progress", async () => {
    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 80,
      hasMoreOlderEvents: true,
    });

    let currentSnapshot: ChatThreadSnapshot = snapshotNeedsBackfill;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    listEventsPageMock.mockResolvedValue({
      data: [makeEvent(500)],
      pageInfo: {
        hasMoreOlder: true,
        nextBeforeIdx: 500,
        oldestIdx: 500,
        newestIdx: 500,
      },
    });

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: () => {
                // noop
              },
              hydrationBackfillPolicy: "auto",
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks(8);
    expect(listEventsPageMock).toHaveBeenCalledTimes(1);

    renderHarness();
    await flushMicrotasks(8);
    expect(listEventsPageMock).toHaveBeenCalledTimes(1);
  });

  it("auto-backfill still runs for real needs-backfill transition", async () => {
    const snapshotComplete = makeSnapshot({
      eventsStatus: "complete",
      recommendedBackfill: false,
      nextBeforeIdx: null,
      hasMoreOlderEvents: false,
    });

    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 80,
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
              hydrationBackfillPolicy: "auto",
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
      expect.objectContaining({ beforeIdx: 80 }),
    );
  });

  it("runs bounded auto-backfill for large initial gap when timeline is not marked incomplete", async () => {
    const snapshotLargeGap = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 500,
      hasMoreOlderEvents: true,
    });

    let currentSnapshot: ChatThreadSnapshot = snapshotLargeGap;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: () => {
                // noop
              },
              hydrationBackfillPolicy: "auto",
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks(6);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);
    expect(listEventsPageMock).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ beforeIdx: 500, limit: 300 }),
    );
  });

  it("stops bounded auto-backfill after first semantic boundary page", async () => {
    const snapshotLargeGap = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 500,
      hasMoreOlderEvents: true,
    });

    let currentSnapshot: ChatThreadSnapshot = snapshotLargeGap;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    listEventsPageMock.mockResolvedValue({
      data: [
        makeEvent(500, {
          type: "plan.created",
          payload: {
            messageId: "msg-1",
            source: "claude_plan_file",
            content: "# Plan\n- Step 1",
            filePath: ".claude/plans/plan.md",
          },
        }),
      ],
      pageInfo: {
        hasMoreOlder: true,
        nextBeforeIdx: 450,
        oldestIdx: 500,
        newestIdx: 500,
      },
    });

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: () => {
                // noop
              },
              hydrationBackfillPolicy: "auto",
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks(8);

    expect(listEventsPageMock).toHaveBeenCalledTimes(1);
  });

  it("continues bounded auto-backfill when first page has no semantic boundary", async () => {
    const snapshotLargeGap = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 500,
      hasMoreOlderEvents: true,
    });

    let currentSnapshot: ChatThreadSnapshot = snapshotLargeGap;
    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => currentSnapshot);

    listEventsPageMock
      .mockResolvedValueOnce({
        data: [
          makeEvent(500, {
            type: "chat.completed",
            payload: { messageId: "msg-1", source: "chat.thread.metadata" },
          }),
        ],
        pageInfo: {
          hasMoreOlder: true,
          nextBeforeIdx: 450,
          oldestIdx: 500,
          newestIdx: 500,
        },
      })
      .mockResolvedValueOnce({
        data: [
          makeEvent(450, {
            type: "tool.finished",
            payload: { toolName: "Read", summary: "Read file.ts" },
          }),
        ],
        pageInfo: {
          hasMoreOlder: true,
          nextBeforeIdx: 400,
          oldestIdx: 450,
          newestIdx: 450,
        },
      });

    const renderHarness = () => {
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HookHarness, {
              onResult: () => {
                // noop
              },
              hydrationBackfillPolicy: "auto",
            }),
          ),
        );
      });
    };

    renderHarness();
    await flushMicrotasks(8);

    expect(listEventsPageMock).toHaveBeenCalledTimes(2);
    expect(listEventsPageMock).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.objectContaining({ beforeIdx: 500, limit: 300 }),
    );
    expect(listEventsPageMock).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      expect.objectContaining({ beforeIdx: 450, limit: 300 }),
    );
  });

  it("opens and closes semantic hydration gate around manual loadOlderHistory", async () => {
    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 500,
      hasMoreOlderEvents: true,
    });

    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? snapshotNeedsBackfill : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => snapshotNeedsBackfill);

    let resolveEventsPage: ((value: {
      data: ChatEvent[];
      pageInfo: {
        hasMoreOlder: boolean;
        nextBeforeIdx: number | null;
        oldestIdx: number | null;
        newestIdx: number | null;
      };
    }) => void) | null = null;

    listMessagesPageMock.mockResolvedValue({
      data: [],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: null,
        newestSeq: null,
      },
    });

    listEventsPageMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveEventsPage = resolve;
      }),
    );

    let latestResult: ReturnType<typeof useChatSession> | undefined;

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

    await flushMicrotasks(4);

    if (!latestResult) {
      throw new Error("Expected useChatSession result");
    }

    expect(latestResult.semanticHydrationInProgress).toBe(false);
    expect(latestResult.timelineSummary.oldestRenderableHydrationPending).toBe(false);

    await act(async () => {
      void latestResult?.loadOlderHistory({ requestId: "manual-gate-test", source: "manual" });
      await Promise.resolve();
    });

    expect(latestResult.semanticHydrationInProgress).toBe(true);
    expect(latestResult.timelineSummary.headIdentityStable).toBe(true);

    if (!resolveEventsPage) {
      throw new Error("Expected deferred events page resolver");
    }

    await act(async () => {
      resolveEventsPage?.({
        data: [makeEvent(500)],
        pageInfo: {
          hasMoreOlder: false,
          nextBeforeIdx: null,
          oldestIdx: 500,
          newestIdx: 500,
        },
      });
      await Promise.resolve();
    });

    await flushMicrotasks(4);
    expect(latestResult.semanticHydrationInProgress).toBe(false);
    expect(latestResult.timelineSummary.oldestRenderableHydrationPending).toBe(false);
  });

  it("opens and closes semantic hydration gate during auto-backfill", async () => {
    const snapshotNeedsBackfill = makeSnapshot({
      eventsStatus: "needs_backfill",
      recommendedBackfill: true,
      nextBeforeIdx: 80,
      hasMoreOlderEvents: true,
    });

    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? snapshotNeedsBackfill : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => snapshotNeedsBackfill);

    let resolveEventsPage: ((value: {
      data: ChatEvent[];
      pageInfo: {
        hasMoreOlder: boolean;
        nextBeforeIdx: number | null;
        oldestIdx: number | null;
        newestIdx: number | null;
      };
    }) => void) | null = null;

    listMessagesPageMock.mockResolvedValue({
      data: [],
      pageInfo: {
        hasMoreOlder: false,
        nextBeforeSeq: null,
        oldestSeq: null,
        newestSeq: null,
      },
    });

    listEventsPageMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveEventsPage = resolve;
      }),
    );

    let latestResult: ReturnType<typeof useChatSession> | undefined;

    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(HookHarness, {
            onResult: (result) => {
              latestResult = result;
            },
            hydrationBackfillPolicy: "auto",
          }),
        ),
      );
    });

    await flushMicrotasks(5);

    if (!latestResult) {
      throw new Error("Expected useChatSession result");
    }

    expect(latestResult.semanticHydrationInProgress).toBe(true);
    expect(latestResult.timelineSummary.headIdentityStable).toBe(true);

    if (!resolveEventsPage) {
      throw new Error("Expected deferred events page resolver");
    }

    await act(async () => {
      resolveEventsPage?.({
        data: [makeEvent(70)],
        pageInfo: {
          hasMoreOlder: false,
          nextBeforeIdx: null,
          oldestIdx: 70,
          newestIdx: 70,
        },
      });
      await Promise.resolve();
    });

    await flushMicrotasks(5);
    expect(latestResult.semanticHydrationInProgress).toBe(false);
    expect(latestResult.timelineSummary.oldestRenderableHydrationPending).toBe(false);
  });

  it("preserves messages/events when same-thread snapshot is temporarily unavailable", async () => {
    const stableSnapshot = makeSnapshot({
      eventsStatus: "complete",
      recommendedBackfill: false,
      nextBeforeIdx: null,
      hasMoreOlderEvents: false,
      newestIdx: 1000,
    });

    let currentSnapshot: ChatThreadSnapshot | undefined = stableSnapshot;

    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId ? currentSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => stableSnapshot);

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
    await flushMicrotasks(6);

    if (!latestResult) {
      throw new Error("Expected useChatSession result");
    }

    expect(latestResult.selectedThreadId).toBe("thread-1");
    expect(latestResult.messages.map((message) => message.id)).toEqual(["msg-1"]);
    expect(latestResult.events.map((event) => event.id)).toEqual(["event-1000"]);

    currentSnapshot = undefined;
    renderHarness();
    await flushMicrotasks(4);

    if (!latestResult) {
      throw new Error("Expected useChatSession result");
    }

    expect(latestResult.selectedThreadId).toBe("thread-1");
    expect(latestResult.messages.map((message) => message.id)).toEqual(["msg-1"]);
    expect(latestResult.events.map((event) => event.id)).toEqual(["event-1000"]);
  });

  it("clears messages/events when switching to a new thread without snapshot", async () => {
    const stableSnapshot = makeSnapshot({
      eventsStatus: "complete",
      recommendedBackfill: false,
      nextBeforeIdx: null,
      hasMoreOlderEvents: false,
      newestIdx: 1000,
    });

    const secondThread: ChatThread = {
      ...makeThread(),
      id: "thread-2",
      title: "Thread 2",
    };

    useThreadsMock.mockReturnValue({ data: [makeThread(), secondThread] });

    useThreadSnapshotMock.mockImplementation((threadId: string | null) => ({
      data: threadId === "thread-1" ? stableSnapshot : undefined,
    }));

    getThreadSnapshotMock.mockImplementation(async () => stableSnapshot);

    let latestResult: ReturnType<typeof useChatSession> | undefined;

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

    await flushMicrotasks(6);

    if (!latestResult) {
      throw new Error("Expected useChatSession result");
    }

    expect(latestResult.selectedThreadId).toBe("thread-1");
    expect(latestResult.messages.map((message) => message.id)).toEqual(["msg-1"]);
    expect(latestResult.events.map((event) => event.id)).toEqual(["event-1000"]);

    act(() => {
      latestResult?.setSelectedThreadId("thread-2");
    });

    await flushMicrotasks(5);

    if (!latestResult) {
      throw new Error("Expected useChatSession result");
    }

    expect(latestResult.selectedThreadId).toBe("thread-2");
    expect(latestResult.messages).toEqual([]);
    expect(latestResult.events).toEqual([]);
  });

});
