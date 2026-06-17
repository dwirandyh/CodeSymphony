import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread } from "@codesymphony/shared-types";
import { ChatPane } from "./ChatPane";

// ChatMessageList + Composer + gate cards are heavy lazy children. Mock them as
// lightweight probes so the test isolates ChatPane's wiring: each pane must
// render its OWN thread's surface (empty-state + composer), never a forced
// shimmer just because it is not the globally-focused pane.
const { chatMessageListProps, composerProps } = vi.hoisted(() => ({
  chatMessageListProps: { current: null as Record<string, unknown> | null },
  composerProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("./chat-message-list", () => ({
  ChatMessageList: (props: Record<string, unknown>) => {
    chatMessageListProps.current = props;
    return (
      <div data-testid="chat-message-list" data-empty-state={String(props.emptyState ?? "")}>
        {props.footer as React.ReactNode}
      </div>
    );
  },
}));

vi.mock("./composer", () => ({
  Composer: (props: Record<string, unknown>) => {
    composerProps.current = props;
    return <div data-testid="composer" data-thread-id={String(props.threadId ?? "")} />;
  },
}));

vi.mock("./PermissionPromptCard", () => ({
  PermissionPromptCard: () => <div data-testid="permission-prompt-card" />,
}));
vi.mock("./QuestionCard", () => ({
  QuestionCard: () => <div data-testid="question-card" />,
}));
vi.mock("./PlanDecisionComposer", () => ({
  PlanDecisionComposer: () => <div data-testid="plan-decision-composer" />,
}));

// Isolate the per-thread sub-hook behind a controllable mock so the test drives
// ChatPane's rendering purely from a ThreadPaneSession shape.
const { useThreadPaneSessionMock } = vi.hoisted(() => ({
  useThreadPaneSessionMock: vi.fn(),
}));

vi.mock("../../pages/workspace/hooks/chat-session/useThreadPaneSession", () => ({
  useThreadPaneSession: useThreadPaneSessionMock,
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

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
    modelOptions: [],
    modelOptionsPerModel: {},
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

function makeSession(overrides?: Record<string, unknown>) {
  return {
    threadId: "thread-x",
    thread: makeThread("thread-x"),
    messages: [],
    events: [],
    timelineItems: [],
    messageListEmptyState: "existing-thread-empty",
    threadUiStatus: "idle",
    showStopAction: false,
    stoppingRun: false,
    gates: {
      pendingPermissionRequests: [],
      pendingQuestionRequests: [],
      resolvingPermissionIds: new Set<string>(),
      answeringQuestionIds: new Set<string>(),
      dismissingQuestionIds: new Set<string>(),
      planActionBusy: false,
      showPlanDecisionComposer: false,
      isWaitingForUserGate: false,
      resolvePermission: vi.fn(),
      answerQuestion: vi.fn(),
      dismissQuestion: vi.fn(),
      handleApprovePlan: vi.fn(),
      handleRevisePlan: vi.fn(),
      handleDismissPlan: vi.fn(),
    },
    composerAgent: "claude",
    composerModel: "claude-sonnet-4-6",
    composerModelProviderId: null,
    composerModelOptions: [],
    composerModelOptionsPerModel: {},
    composerMode: "default",
    composerModeLocked: false,
    composerPermissionMode: "default",
    composerDisabled: false,
    threadKind: "default",
    submitMessage: vi.fn().mockResolvedValue(true),
    setComposerMode: vi.fn().mockResolvedValue(undefined),
    setComposerAgentSelection: vi.fn().mockResolvedValue(undefined),
    setComposerPermissionMode: vi.fn().mockResolvedValue(undefined),
    stopAssistantRun: vi.fn().mockResolvedValue(undefined),
    queuedMessages: [],
    queueDraft: vi.fn().mockResolvedValue(true),
    updateQueuedDraft: vi.fn().mockResolvedValue(true),
    dispatchQueuedDraft: vi.fn().mockResolvedValue(undefined),
    cancelQueuedDraftDispatch: vi.fn().mockResolvedValue(undefined),
    deleteQueuedDraft: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderPane(threadId: string) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatPane
          threadId={threadId}
          thread={makeThread(threadId)}
          worktreeId="wt-1"
          repositoryId="repo-1"
          worktreeOperational
          worktreePath="/tmp/wt-1"
          providers={[]}
          claudeModels={[]}
          codexModels={[]}
          cursorModels={[]}
          opencodeModels={[]}
          modelCatalogReadyByAgent={{}}
          runtimeInfo={null}
          slashCommands={[]}
          slashCommandsLoading={false}
          sendMessagesWith="enter"
          autoConvertLongTextEnabled={false}
          onSubmitMessage={vi.fn().mockResolvedValue(true)}
          onSetThreadMode={vi.fn().mockResolvedValue(undefined)}
          onSetThreadAgentSelection={vi.fn().mockResolvedValue(undefined)}
          onSetThreadPermissionMode={vi.fn().mockResolvedValue(undefined)}
          onStopAssistantRun={vi.fn().mockResolvedValue(undefined)}
          onError={vi.fn()}
          onOpenReadFile={vi.fn()}
          onAgentModelSelectorOpen={vi.fn()}
        />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  chatMessageListProps.current = null;
  composerProps.current = null;
  useThreadPaneSessionMock.mockReset();
  useThreadPaneSessionMock.mockImplementation(() => makeSession());
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

describe("ChatPane", () => {
  it("renders its own thread's message list and composer (no forced shimmer)", () => {
    renderPane("thread-x");

    const list = container.querySelector("[data-testid='chat-message-list']");
    expect(list).not.toBeNull();
    // The split-pane bug forced "loading-thread" on non-focused panes. The pane
    // must surface the session's real empty-state instead.
    expect(list?.getAttribute("data-empty-state")).toBe("existing-thread-empty");

    const composer = container.querySelector("[data-testid='composer']");
    expect(composer).not.toBeNull();
    expect(composer?.getAttribute("data-thread-id")).toBe("thread-x");
  });

  it("binds the composer submit to its own pane session", async () => {
    const submitMessage = vi.fn().mockResolvedValue(true);
    useThreadPaneSessionMock.mockImplementation(() => makeSession({ threadId: "thread-x", submitMessage }));

    renderPane("thread-x");

    await act(async () => {
      await (composerProps.current?.onSubmitMessage as (p: unknown) => Promise<boolean>)({
        content: "Hi",
        mode: "default",
        attachments: [],
      });
    });

    expect(submitMessage).toHaveBeenCalledWith("Hi", "default", []);
  });

  it("shows the plan decision composer in the list footer while awaiting a plan decision", async () => {
    useThreadPaneSessionMock.mockImplementation(() =>
      makeSession({
        gates: {
          ...makeSession().gates,
          showPlanDecisionComposer: true,
        },
      }),
    );

    renderPane("thread-x");
    // The plan/permission/question cards are lazy() in ChatPane; flush the
    // dynamic import so Suspense resolves to the mocked component.
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='plan-decision-composer']")).not.toBeNull();
  });

  it("hides the composer while a user gate is pending", () => {
    useThreadPaneSessionMock.mockImplementation(() =>
      makeSession({
        gates: {
          ...makeSession().gates,
          isWaitingForUserGate: true,
        },
      }),
    );

    renderPane("thread-x");

    expect(container.querySelector("[data-testid='composer']")).toBeNull();
  });

  it("renders a permission prompt when the pane's thread has a pending permission", async () => {
    useThreadPaneSessionMock.mockImplementation(() =>
      makeSession({
        gates: {
          ...makeSession().gates,
          isWaitingForUserGate: true,
          pendingPermissionRequests: [
            {
              requestId: "req-1",
              toolName: "Bash",
              command: "ls",
              editTarget: null,
              blockedPath: null,
              decisionReason: null,
              canAlwaysAllow: false,
              alwaysAllowScope: null,
              alwaysAllowDescription: null,
            },
          ],
        },
      }),
    );

    renderPane("thread-x");
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='permission-prompt-card']")).not.toBeNull();
  });
});
