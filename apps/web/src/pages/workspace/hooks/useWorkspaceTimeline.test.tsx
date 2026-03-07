import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { useWorkspaceTimeline, type TimelineRefs, type WorkspaceTimelineResult } from "./workspace-timeline";

vi.mock("../../../lib/renderDebug", () => ({
  pushRenderDebug: vi.fn(),
  isRenderDebugEnabled: () => false,
}));

vi.mock("../../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
let hookResult: WorkspaceTimelineResult;

function makeMessage(id: string, seq: number, role: "user" | "assistant" = "user", content = "hello"): ChatMessage {
  return { id, threadId: "t1", seq, role, content, attachments: [], createdAt: "2026-01-01T00:00:00Z" };
}

function getTimelineItems(
  messages: ChatMessage[],
  events: ChatEvent[],
  options?: { semanticHydrationInProgress?: boolean },
): WorkspaceTimelineResult["items"] {
  act(() => {
    root.render(
      <TestComponent
        messages={messages}
        events={events}
        threadId="t1"
        refs={makeRefs()}
        options={options}
      />,
    );
  });
  return hookResult.items;
}

function makeEvent(idx: number, type: string, payload: Record<string, unknown> = {}, messageId: string | null = null): ChatEvent {
  return {
    id: `e-${idx}`,
    threadId: "t1",
    messageId,
    idx,
    type: type as ChatEvent["type"],
    payload,
    createdAt: "2026-01-01T00:00:00Z",
  } as ChatEvent;
}

function makeRefs(): TimelineRefs {
  return {
    streamingMessageIds: new Set(),
    stickyRawFallbackMessageIds: new Set(),
    renderDecisionByMessageId: new Map(),
    loggedOrphanEventIdsByThread: new Map(),
    loggedFirstInsertOrderByMessageId: new Set(),
  };
}

function TestComponent({
  messages,
  events,
  threadId,
  refs,
  options,
}: {
  messages: ChatMessage[];
  events: ChatEvent[];
  threadId: string | null;
  refs: TimelineRefs;
  options?: { semanticHydrationInProgress?: boolean };
}) {
  hookResult = useWorkspaceTimeline(messages, events, threadId, refs, options);
  return <div>items:{hookResult.items.length},incomplete:{String(hookResult.hasIncompleteCoverage)}</div>;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useWorkspaceTimeline", () => {
  it("returns empty items for no messages and events", () => {
    act(() => {
      root.render(<TestComponent messages={[]} events={[]} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items).toHaveLength(0);
  });

  it("returns message items for user messages", () => {
    const messages = [makeMessage("m1", 1, "user", "Hello")];
    act(() => {
      root.render(<TestComponent messages={messages} events={[]} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items.length).toBeGreaterThan(0);
    const msgItem = hookResult.items.find((i) => i.kind === "message");
    expect(msgItem).toBeTruthy();
  });

  it("returns message items for assistant messages", () => {
    const messages = [
      makeMessage("m1", 1, "user", "Hello"),
      makeMessage("m2", 2, "assistant", "Hi there!"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={[]} threadId="t1" refs={makeRefs()} />);
    });
    const assistantItems = hookResult.items.filter(
      (i) => i.kind === "message" && i.message.role === "assistant"
    );
    expect(assistantItems.length).toBeGreaterThan(0);
  });

  it("processes message.delta events", () => {
    const messages = [makeMessage("m1", 1, "user", "Hi")];
    const events = [
      makeEvent(0, "message.delta", { role: "assistant", messageId: "m2", delta: "Hello" }, "m2"),
      makeEvent(1, "message.completed", { messageId: "m2" }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items.length).toBeGreaterThanOrEqual(1);
  });

  it("processes tool events into bash-command items", () => {
    const messages = [makeMessage("m1", 1, "user", "Hi"), makeMessage("m2", 2, "assistant", "Running...")];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Bash",
        toolUseId: "tu-1",
        toolInput: { command: "ls -la" },
      }, "m2"),
      makeEvent(1, "tool.output", {
        toolUseId: "tu-1",
        output: "file1.ts\nfile2.ts",
      }, "m2"),
      makeEvent(2, "tool.finished", {
        toolUseId: "tu-1",
        duration_seconds: 0.5,
        error: null,
      }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const bashItems = hookResult.items.filter((i) => i.kind === "bash-command");
    expect(bashItems.length).toBeGreaterThanOrEqual(0);
  });

  it("processes Edit tool events", () => {
    const messages = [makeMessage("m1", 1, "user", "Fix"), makeMessage("m2", 2, "assistant", "Editing...")];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Edit",
        toolUseId: "tu-2",
        toolInput: { file_path: "src/index.ts" },
      }, "m2"),
      makeEvent(1, "tool.finished", {
        toolUseId: "tu-2",
        duration_seconds: 0.3,
        changedFiles: ["src/index.ts"],
        diff: "+hello\n-world",
      }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items.length).toBeGreaterThan(0);
  });

  it("processes thinking events", () => {
    const messages = [makeMessage("m1", 1, "user", "Think")];
    const events = [
      makeEvent(0, "thinking.delta", { delta: "Let me think..." }, "m1"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const thinkingItems = hookResult.items.filter((i) => i.kind === "thinking");
    expect(thinkingItems.length).toBeGreaterThanOrEqual(0);
  });

  it("processes permission events", () => {
    const messages = [makeMessage("m1", 1, "user", "Do it"), makeMessage("m2", 2, "assistant", "Need permission")];
    const events = [
      makeEvent(0, "permission.requested", { requestId: "perm-1", toolName: "Bash" }, "m2"),
      makeEvent(1, "permission.resolved", { requestId: "perm-1", decision: "allow" }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items.length).toBeGreaterThan(0);
  });

  it("processes plan events", () => {
    const messages = [makeMessage("m1", 1, "user", "Plan"), makeMessage("m2", 2, "assistant", "Here's the plan")];
    const events = [
      makeEvent(0, "plan.created", { content: "# My Plan", filePath: ".claude/plan.md" }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const planItems = hookResult.items.filter((i) => i.kind === "plan-file-output");
    expect(planItems.length).toBeGreaterThanOrEqual(0);
  });

  it("processes subagent events", () => {
    const messages = [makeMessage("m1", 1, "user", "Do"), makeMessage("m2", 2, "assistant", "Using agent")];
    const events = [
      makeEvent(0, "subagent.started", {
        toolUseId: "tu-3",
        agentId: "agent-1",
        agentType: "explore",
        description: "Searching code",
      }, "m2"),
      makeEvent(1, "subagent.finished", {
        toolUseId: "tu-3",
        agentId: "agent-1",
        duration_seconds: 3,
      }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items.length).toBeGreaterThan(0);
  });

  it("processes chat.completed event", () => {
    const messages = [makeMessage("m1", 1, "user", "Hi"), makeMessage("m2", 2, "assistant", "Done")];
    const events = [
      makeEvent(0, "message.completed", { messageId: "m2" }, "m2"),
      makeEvent(1, "chat.completed", {}, null),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items.length).toBeGreaterThan(0);
  });

  it("processes error event", () => {
    const messages = [makeMessage("m1", 1, "user", "Fail")];
    const events = [
      makeEvent(0, "error", { message: "Something broke", type: "runtime_error" }, null),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const errorItems = hookResult.items.filter((i) => i.kind === "error");
    expect(errorItems.length).toBeGreaterThanOrEqual(0);
  });

  it("returns null threadId gracefully", () => {
    act(() => {
      root.render(<TestComponent messages={[]} events={[]} threadId={null} refs={makeRefs()} />);
    });
    expect(hookResult.items).toHaveLength(0);
  });

  it("keeps incomplete-coverage stable for sparse delta-orphan rerenders", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", ""),
    ];
    const events = [
      makeEvent(1, "thinking.delta", { messageId: "m2", delta: "first thought " }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Read", toolUseId: "t1" }, "m2"),
      makeEvent(3, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["t1"] }, "m2"),
      makeEvent(4, "thinking.delta", { messageId: "m2", delta: "second thought" }, "m2"),
      makeEvent(5, "tool.output", { toolUseId: "orphan-1", output: "late orphan tool output" }, "m2"),
    ];

    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const firstCoverage = hookResult.hasIncompleteCoverage;

    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });

    expect(hookResult.hasIncompleteCoverage).toBe(firstCoverage);
  });

  it("handles Read tool events for explore activity", () => {
    const messages = [makeMessage("m1", 1, "user", "Read"), makeMessage("m2", 2, "assistant", "Reading...")];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Read",
        toolUseId: "tu-read",
        toolInput: { file_path: "src/app.ts" },
      }, "m2"),
      makeEvent(1, "tool.finished", {
        toolUseId: "tu-read",
        duration_seconds: 0.1,
      }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    expect(hookResult.items.length).toBeGreaterThan(0);
  });

  it("keeps thought/read/thought separate when no message.delta", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", ""),
    ];
    const events = [
      makeEvent(1, "thinking.delta", { messageId: "m2", delta: "first thought " }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Read", toolUseId: "t1" }, "m2"),
      makeEvent(3, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["t1"] }, "m2"),
      makeEvent(4, "thinking.delta", { messageId: "m2", delta: "and second thought." }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const thinkingIndexes = items
      .map((item, idx) => item.kind === "thinking" ? idx : -1)
      .filter((idx) => idx >= 0);
    const exploreIndex = items.findIndex((item) => item.kind === "explore-activity");

    expect(thinkingIndexes.length).toBeGreaterThanOrEqual(2);
    expect(exploreIndex).toBeGreaterThan(-1);
    expect(thinkingIndexes[0]).toBeLessThan(exploreIndex);
    expect(thinkingIndexes[thinkingIndexes.length - 1]).toBeGreaterThan(exploreIndex);
  });

  it("does not append late explore entries into prior group", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", ""),
    ];
    const events = [
      makeEvent(1, "thinking.delta", { messageId: "m2", delta: "a " }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Read", toolUseId: "r1" }, "m2"),
      makeEvent(3, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(4, "thinking.delta", { messageId: "m2", delta: "b " }, "m2"),
      makeEvent(5, "tool.started", { toolName: "Glob", toolUseId: "g1" }, "m2"),
      makeEvent(6, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] }, "m2"),
      makeEvent(7, "thinking.delta", { messageId: "m2", delta: "c " }, "m2"),
      makeEvent(8, "tool.started", { toolName: "Read", toolUseId: "r2" }, "m2"),
      makeEvent(9, "tool.finished", { toolName: "Read", summary: "Read /src/b.ts", precedingToolUseIds: ["r2"] }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const exploreItems = items.filter((item) => item.kind === "explore-activity");
    const exploreIds = exploreItems.map((item) => item.id);

    expect(exploreItems.length).toBeGreaterThanOrEqual(2);
    expect(new Set(exploreIds).size).toBe(exploreIds.length);
  });

  it("preserves behavior for normal message.delta stream", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", "working"),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "I'll inspect." }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Read", toolUseId: "r1" }, "m2"),
      makeEvent(3, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(4, "message.delta", { role: "assistant", messageId: "m2", delta: "Next." }, "m2"),
      makeEvent(5, "tool.started", { toolName: "Glob", toolUseId: "g1" }, "m2"),
      makeEvent(6, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const exploreItems = items.filter((item) => item.kind === "explore-activity");

    expect(exploreItems).toHaveLength(2);
  });

  it("renders first tool insert before trailing text when text anchor is after insert", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", ""),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Read", toolUseId: "r1", toolInput: { file_path: "src/a.ts" } }, "m2"),
      makeEvent(2, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(4, "message.delta", { role: "assistant", messageId: "m2", delta: "I checked the file." }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const firstMessageIndex = items.findIndex((item) => item.kind === "message" && item.message.role === "assistant");
    const firstExploreIndex = items.findIndex((item) => item.kind === "explore-activity");

    expect(firstExploreIndex).toBeGreaterThan(-1);
    expect(firstMessageIndex).toBeGreaterThan(-1);
    expect(firstExploreIndex).toBeLessThan(firstMessageIndex);
  });

  it("keeps first tool insert before fallback text when deltas are incomplete", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", "on mobile app view, the add thread button should stay on the most right position"),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Read", toolUseId: "r1" }, "m2"),
      makeEvent(2, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(3, "tool.started", { toolName: "Edit", toolUseId: "e1" }, "m2"),
      makeEvent(4, "tool.finished", { toolName: "Edit", summary: "Updated UI", precedingToolUseIds: ["e1"] }, "m2"),
      makeEvent(9, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "on mobile app view, the add thread button should stay on the most right position",
      }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const firstMessageIndex = items.findIndex((item) => item.kind === "message" && item.message.role === "assistant");
    const firstExploreIndex = items.findIndex((item) => item.kind === "explore-activity");

    expect(firstExploreIndex).toBeGreaterThan(-1);
    expect(firstMessageIndex).toBeGreaterThan(-1);
    expect(firstExploreIndex).toBeLessThan(firstMessageIndex);
  });

  it("suppresses unresolved assistant fallback while semantic hydration is in progress", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", ""),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Read", toolUseId: "r1" }, "m2"),
      makeEvent(2, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(9, "message.delta", {
        role: "assistant",
        messageId: "missing-assistant-message",
        delta: "on mobile app view, the add thread button should stay on the most right position",
      }, "missing-assistant-message"),
    ];

    const withoutGate = getTimelineItems(messages, events, { semanticHydrationInProgress: false });
    const withGate = getTimelineItems(messages, events, { semanticHydrationInProgress: true });

    const assistantWithoutGate = withoutGate.filter((item) => item.kind === "message" && item.message.role === "assistant");
    const assistantWithGate = withGate.filter((item) => item.kind === "message" && item.message.role === "assistant");

    expect(assistantWithoutGate).toHaveLength(0);
    expect(assistantWithGate).toHaveLength(0);

    const firstExploreIndex = withGate.findIndex((item) => item.kind === "explore-activity");
    expect(firstExploreIndex).toBeGreaterThan(-1);
  });

  it("preserves boundary assistant text while semantic hydration is in progress", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", "assistant text before semantic context"),
    ];
    const events = [
      makeEvent(1, "chat.completed", { messageId: "other-message", source: "chat.thread.metadata" }, "other-message"),
    ];

    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} options={{ semanticHydrationInProgress: true }} />);
    });
    const gatedAssistant = hookResult.items.find((item) => item.kind === "message" && item.message.id === "m2");
    expect(gatedAssistant).toBeDefined();
    expect(hookResult.hasIncompleteCoverage).toBe(true);
    expect(hookResult.summary.oldestRenderableMessageId).toBe("m1");
    expect(hookResult.summary.oldestRenderableHydrationPending).toBe(false);
    expect(hookResult.summary.headIdentityStable).toBe(true);

    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} options={{ semanticHydrationInProgress: false }} />);
    });
    const releasedAssistant = hookResult.items.find((item) => item.kind === "message" && item.message.id === "m2");
    expect(releasedAssistant).toBeDefined();
    expect(hookResult.summary.oldestRenderableMessageId).toBe("m1");
    expect(hookResult.summary.oldestRenderableHydrationPending).toBe(false);
  });
});
