import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatMessage, ChatThread } from "@codesymphony/shared-types";
import {
  getThreadCollections,
  resetThreadCollectionsForTest,
} from "../../../../collections/threadCollections";
import { resetThreadStreamStateRegistryForTest } from "../../../../collections/threadStreamState";
import { useThreadPaneSession } from "./useThreadPaneSession";

// The pane session composes useThreadEventStream + useWorkspaceTimeline; mock
// both so the test isolates per-thread derivation (status/empty-state/submit).
vi.mock("./useThreadEventStream", () => ({
  useThreadEventStream: vi.fn(),
}));

// The queue is owned self-contained by the pane hook (mirroring usePendingGates'
// own-api pattern); mock the api so the test can assert per-thread targeting.
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listQueuedMessages: vi.fn(),
    queueMessage: vi.fn(),
    updateQueuedMessage: vi.fn(),
    deleteQueuedMessage: vi.fn(),
    requestQueuedMessageDispatch: vi.fn(),
    cancelQueuedMessageDispatch: vi.fn(),
    approvePlan: vi.fn(),
  },
}));

vi.mock("../../../../lib/api", () => ({
  api: apiMock,
}));

const { useWorkspaceTimelineMock } = vi.hoisted(() => ({
  useWorkspaceTimelineMock: vi.fn(),
}));

vi.mock("../workspace-timeline", () => ({
  useWorkspaceTimeline: useWorkspaceTimelineMock,
}));

vi.mock("../../../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

// Snapshot queries are external deps; mock them as resolved-empty so the test
// isolates the hook's per-thread derivation (matches useChatSession.render.test).
const { useThreadSnapshotMock, useThreadStatusSnapshotMock } = vi.hoisted(() => ({
  useThreadSnapshotMock: vi.fn(() => ({ data: null, isLoading: false, isFetching: false })),
  useThreadStatusSnapshotMock: vi.fn(() => ({ data: null, isLoading: false, isFetching: false })),
}));

vi.mock("../../../../hooks/queries/useThreadSnapshot", () => ({
  useThreadSnapshot: useThreadSnapshotMock,
}));

vi.mock("../../../../hooks/queries/useThreadStatusSnapshot", () => ({
  useThreadStatusSnapshot: useThreadStatusSnapshotMock,
}));

let hookResult: ReturnType<typeof useThreadPaneSession>;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const onSubmitMessageMock = vi.fn<(content: string, threadId: string) => Promise<boolean>>();
const onSetThreadModeMock = vi.fn<(threadId: string, mode: string) => Promise<void>>();
const onSetThreadAgentSelectionMock = vi.fn<(threadId: string, selection: unknown) => Promise<void>>();
const onSetThreadPermissionModeMock = vi.fn<(threadId: string, mode: string) => Promise<void>>();
const onStopAssistantRunMock = vi.fn<(threadId: string) => Promise<void>>();
const onPlanApprovedMock = vi.fn();

function makeThread(id: string, overrides?: Partial<ChatThread>): ChatThread {
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
    active: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function HookHarness({ threadId, thread }: { threadId: string; thread: ChatThread | null }) {
  hookResult = useThreadPaneSession(threadId, {
    thread,
    worktreeId: "wt-1",
    repositoryId: "repo-1",
    worktreeOperational: true,
    worktreePath: "/tmp/wt-1",
    onSubmitMessage: onSubmitMessageMock,
    onSetThreadMode: onSetThreadModeMock,
    onSetThreadAgentSelection: onSetThreadAgentSelectionMock,
    onSetThreadPermissionMode: onSetThreadPermissionModeMock,
    onStopAssistantRun: onStopAssistantRunMock,
    onError: vi.fn(),
    onPlanApproved: onPlanApprovedMock,
  });
  return null;
}

function renderHook(threadId: string, thread: ChatThread | null) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookHarness threadId={threadId} thread={thread} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  resetThreadCollectionsForTest();
  resetThreadStreamStateRegistryForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onSubmitMessageMock.mockReset();
  onSubmitMessageMock.mockResolvedValue(true);
  onSetThreadModeMock.mockReset();
  onSetThreadModeMock.mockResolvedValue(undefined);
  onSetThreadAgentSelectionMock.mockReset();
  onSetThreadAgentSelectionMock.mockResolvedValue(undefined);
  onSetThreadPermissionModeMock.mockReset();
  onSetThreadPermissionModeMock.mockResolvedValue(undefined);
  onStopAssistantRunMock.mockReset();
  onStopAssistantRunMock.mockResolvedValue(undefined);
  onPlanApprovedMock.mockReset();
  apiMock.approvePlan.mockReset();
  apiMock.approvePlan.mockResolvedValue({ executionKind: "inline" });
  apiMock.listQueuedMessages.mockReset();
  apiMock.listQueuedMessages.mockResolvedValue([]);
  apiMock.queueMessage.mockReset();
  apiMock.queueMessage.mockResolvedValue({ id: "q1" });
  apiMock.updateQueuedMessage.mockReset();
  apiMock.updateQueuedMessage.mockResolvedValue({ id: "q1" });
  apiMock.deleteQueuedMessage.mockReset();
  apiMock.deleteQueuedMessage.mockResolvedValue(undefined);
  apiMock.requestQueuedMessageDispatch.mockReset();
  apiMock.requestQueuedMessageDispatch.mockResolvedValue({ id: "q1" });
  apiMock.cancelQueuedMessageDispatch.mockReset();
  apiMock.cancelQueuedMessageDispatch.mockResolvedValue({ id: "q1" });
  useThreadSnapshotMock.mockReset();
  useThreadSnapshotMock.mockReturnValue({ data: null, isLoading: false, isFetching: false });
  useThreadStatusSnapshotMock.mockReset();
  useThreadStatusSnapshotMock.mockReturnValue({ data: null, isLoading: false, isFetching: false });
  useWorkspaceTimelineMock.mockReset();
  useWorkspaceTimelineMock.mockImplementation((messages: ChatMessage[]) => ({
    items: messages.map((message) => ({ kind: "message" as const, message })),
    hasIncompleteCoverage: false,
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
  }));
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  resetThreadCollectionsForTest();
  resetThreadStreamStateRegistryForTest();
  vi.clearAllMocks();
});

describe("useThreadPaneSession", () => {
  it("reports an existing-thread-empty state for a server-backed thread with no messages (not loading shimmer)", () => {
    renderHook("thread-x", makeThread("thread-x"));

    expect(hookResult.timelineItems).toEqual([]);
    // The key bug: a fresh, message-less thread must NOT be stuck on
    // "loading-thread" (shimmer) just because it is not the globally selected pane.
    expect(hookResult.messageListEmptyState).toBe("existing-thread-empty");
  });

  it("does not show loading shimmer when status refetches but timeline snapshot is cached", () => {
    useThreadSnapshotMock.mockReturnValue({
      data: { timelineItems: [], summary: {} },
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useThreadSnapshotMock>);
    useThreadStatusSnapshotMock.mockReturnValue({
      data: null,
      isLoading: true,
      isFetching: true,
    });

    renderHook("thread-refetch", makeThread("thread-refetch"));

    expect(hookResult.messageListEmptyState).toBe("existing-thread-empty");
  });

  it("derives a per-thread running status from the thread.active flag", () => {
    renderHook("thread-active", makeThread("thread-active", { active: true }));

    expect(hookResult.threadUiStatus).toBe("running");
    expect(hookResult.showStopAction).toBe(true);
  });

  it("derives timeline items from the thread's own live collections", () => {
    const message: ChatMessage = {
      id: "m1",
      threadId: "thread-y",
      seq: 1,
      role: "assistant",
      content: "Hello from Y",
      attachments: [],
      createdAt: "2026-01-01T00:00:01Z",
    };
    getThreadCollections("thread-y").messagesCollection.insert(message);

    renderHook("thread-y", makeThread("thread-y"));

    expect(hookResult.messageListEmptyState).toBeNull();
    expect(hookResult.timelineItems).toEqual([{ kind: "message", message }]);
  });

  it("binds submitMessage to its own threadId regardless of global selection", async () => {
    renderHook("thread-z", makeThread("thread-z"));

    await act(async () => {
      await hookResult.submitMessage("Hello Z", "default", []);
    });

    expect(onSubmitMessageMock).toHaveBeenCalledWith("Hello Z", "default", [], "thread-z");
  });

  it("derives per-thread composer fields from the thread record", () => {
    renderHook("thread-c", makeThread("thread-c", {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: "prov-1",
      permissionMode: "full_access",
      mode: "default",
    }));

    expect(hookResult.composerAgent).toBe("codex");
    expect(hookResult.composerModel).toBe("gpt-5.4");
    expect(hookResult.composerModelProviderId).toBe("prov-1");
    expect(hookResult.composerPermissionMode).toBe("full_access");
    // Idle thread: composer enabled, mode unlocked.
    expect(hookResult.composerDisabled).toBe(false);
    expect(hookResult.composerMode).toBe("default");
    expect(hookResult.composerModeLocked).toBe(false);
  });

  it("locks the composer and forces plan mode while the thread awaits a plan decision", () => {
    // A thread parked in review_plan must surface a locked, plan-mode composer
    // in its own pane independent of global selection.
    getThreadCollections("thread-plan").eventsCollection.insert({
      id: "ev-plan",
      threadId: "thread-plan",
      idx: 1,
      type: "plan.created",
      payload: { filePath: ".claude/plans/feature.md", content: "1. Do the thing\n2. Verify it", source: "claude_plan_file", messageId: "asst-plan" },
      createdAt: "2026-01-01T00:00:01Z",
    } as ChatEvent);
    // A plan is only "awaiting decision" once review is ready: a completion
    // event after plan.created (with no post-review execution) signals that.
    getThreadCollections("thread-plan").eventsCollection.insert({
      id: "ev-plan-done",
      threadId: "thread-plan",
      idx: 2,
      type: "chat.completed",
      payload: { messageId: "asst-plan" },
      createdAt: "2026-01-01T00:00:02Z",
    } as ChatEvent);

    renderHook("thread-plan", makeThread("thread-plan"));

    // review_plan status drives mode=plan + locked.
    expect(hookResult.composerMode).toBe("plan");
    expect(hookResult.composerModeLocked).toBe(true);
  });

  it("delegates composer mutations to its own threadId regardless of global selection", async () => {
    renderHook("thread-d", makeThread("thread-d"));

    await act(async () => {
      await hookResult.setComposerMode("plan");
      await hookResult.setComposerAgentSelection({ agent: "codex", model: "gpt-5.4" });
      await hookResult.setComposerPermissionMode("full_access");
      await hookResult.stopAssistantRun();
    });

    expect(onSetThreadModeMock).toHaveBeenCalledWith("thread-d", "plan");
    expect(onSetThreadAgentSelectionMock).toHaveBeenCalledWith("thread-d", { agent: "codex", model: "gpt-5.4" });
    expect(onSetThreadPermissionModeMock).toHaveBeenCalledWith("thread-d", "full_access");
    expect(onStopAssistantRunMock).toHaveBeenCalledWith("thread-d");
  });

  it("owns a per-thread queued-draft list scoped to its own threadId", async () => {
    apiMock.listQueuedMessages.mockResolvedValue([
      { id: "q-1", threadId: "thread-q", content: "queued for q", status: "queued" },
    ]);

    renderHook("thread-q", makeThread("thread-q"));

    // The queue query targets this pane's OWN thread, not the global selection.
    // The query resolves over several microtask turns; flush until it settles.
    for (let attempt = 0; attempt < 20 && hookResult.queuedMessages.length === 0; attempt += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(apiMock.listQueuedMessages).toHaveBeenCalledWith("thread-q");
    expect(hookResult.queuedMessages).toEqual([
      { id: "q-1", threadId: "thread-q", content: "queued for q", status: "queued" },
    ]);
  });

  it("forwards handoff plan-approval results so the parent can switch atomically", async () => {
    const handoffResult = {
      executionKind: "handoff" as const,
      sourceThreadId: "thread-handoff",
      executionThreadId: "thread-exec",
    };
    apiMock.approvePlan.mockResolvedValue(handoffResult);

    // A plan awaiting decision: plan.created followed by chat.completed (review ready).
    getThreadCollections("thread-handoff").eventsCollection.insert({
      id: "ev-plan",
      threadId: "thread-handoff",
      idx: 1,
      type: "plan.created",
      payload: { filePath: ".claude/plans/feature.md", content: "1. Do the thing\n2. Verify it", source: "claude_plan_file", messageId: "asst-plan" },
      createdAt: "2026-01-01T00:00:01Z",
    } as ChatEvent);
    getThreadCollections("thread-handoff").eventsCollection.insert({
      id: "ev-plan-done",
      threadId: "thread-handoff",
      idx: 2,
      type: "chat.completed",
      payload: { messageId: "asst-plan" },
      createdAt: "2026-01-01T00:00:02Z",
    } as ChatEvent);

    renderHook("thread-handoff", makeThread("thread-handoff"));

    await act(async () => {
      await (hookResult.gates.handleApprovePlan as unknown as (input: {
        agent: string;
        model: string;
        modelProviderId: string | null;
      }) => Promise<void>)({
        agent: "claude",
        model: "claude-sonnet-4-6",
        modelProviderId: null,
      });
    });

    expect(apiMock.approvePlan).toHaveBeenCalledWith("thread-handoff", expect.objectContaining({ agent: "claude" }));
    // The pane must forward the handoff result so the parent can register the
    // optimistic exec-thread shell + switch atomically (before content seeds).
    expect(onPlanApprovedMock).toHaveBeenCalledWith(handoffResult);
  });

  it("binds queued-draft mutations to its own threadId", async () => {
    renderHook("thread-q2", makeThread("thread-q2"));

    await act(async () => {
      await hookResult.queueDraft("draft", "default", []);
      await hookResult.updateQueuedDraft("q-9", "edited");
      await hookResult.dispatchQueuedDraft("q-9");
      await hookResult.cancelQueuedDraftDispatch("q-9");
      await hookResult.deleteQueuedDraft("q-9");
    });

    expect(apiMock.queueMessage).toHaveBeenCalledWith("thread-q2", expect.objectContaining({
      content: "draft",
      mode: "default",
    }));
    expect(apiMock.updateQueuedMessage).toHaveBeenCalledWith("thread-q2", "q-9", { content: "edited" });
    expect(apiMock.requestQueuedMessageDispatch).toHaveBeenCalledWith("thread-q2", "q-9");
    expect(apiMock.cancelQueuedMessageDispatch).toHaveBeenCalledWith("thread-q2", "q-9");
    expect(apiMock.deleteQueuedMessage).toHaveBeenCalledWith("thread-q2", "q-9");
  });
});
