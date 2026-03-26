import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { useWorkspaceTimeline, type TimelineRefs, type WorkspaceTimelineResult } from "./workspace-timeline";
import { extractSubagentExploreGroups } from "./workspace-timeline/subagentExploreExtraction";

const { pushRenderDebugMock } = vi.hoisted(() => ({
  pushRenderDebugMock: vi.fn(),
}));

vi.mock("../../../lib/renderDebug", () => ({
  pushRenderDebug: pushRenderDebugMock,
  isRenderDebugEnabled: () => false,
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
    claimedContextEventIdsByThreadMessage: new Map(),
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
  pushRenderDebugMock.mockClear();
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

  it("processes orphan bash tool events into unified tool items", () => {
    const messages = [makeMessage("m1", 1, "user", "Hi")];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Bash",
        toolUseId: "tu-1",
        toolInput: { command: "pwd" },
      }, null),
      makeEvent(1, "tool.output", {
        toolName: "Bash",
        toolUseId: "tu-1",
        output: "file1.ts\nfile2.ts",
        elapsedTimeSeconds: 0.5,
      }, null),
      makeEvent(2, "tool.finished", {
        toolName: "Bash",
        toolUseId: "tu-1",
        summary: "Ran pwd",
        output: "file1.ts\nfile2.ts",
        error: null,
      }, null),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const toolItems = hookResult.items.filter((i) => i.kind === "tool");
    expect(toolItems.length).toBeGreaterThan(0);
    const bashItems = toolItems.filter((item) => item.kind === "tool" && item.shell === "bash");
    expect(bashItems.length).toBeGreaterThan(0);
    expect(bashItems.some((item) => item.command === "pwd")).toBe(true);
  });

  it("does not render commands.updated as orphan tool items", () => {
    const messages = [makeMessage("m1", 1, "user", "Hi")];
    const events = [
      makeEvent(0, "commands.updated", {
        availableCommands: [{ name: "commit", description: "Create a git commit" }],
      }, null),
    ];

    const items = getTimelineItems(messages, events);
    const toolItems = items.filter((item) => item.kind === "tool");
    const errorItems = items.filter((item) => item.kind === "error");

    expect(toolItems).toHaveLength(0);
    expect(errorItems).toHaveLength(0);
  });

  it("routes mixed bash chains as normal tool items, not explore activity", () => {
    const messages = [
      makeMessage("m1", 1, "user", "run command"),
      makeMessage("m2", 2, "assistant", "done"),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Bash",
        toolUseId: "tu-mixed",
        toolInput: { command: "ls && rm -rf tmp && ls" },
      }, "m2"),
      makeEvent(1, "tool.finished", {
        toolName: "Bash",
        toolUseId: "tu-mixed",
        precedingToolUseIds: ["tu-mixed"],
        summary: "Ran ls && rm -rf tmp && ls",
        output: "ok",
        error: null,
      }, "m2"),
      makeEvent(2, "message.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const bashTools = items.filter((item) => item.kind === "tool" && item.shell === "bash");
    const exploreItems = items.filter((item) => item.kind === "explore-activity");

    expect(bashTools).toHaveLength(1);
    expect(exploreItems).toHaveLength(0);
    expect(bashTools[0].kind === "tool" ? bashTools[0].command : null).toBe("ls && rm -rf tmp && ls");
  });

  it("routes mixed bash chains with non-explore prefix as normal tool items", () => {
    const messages = [
      makeMessage("m1", 1, "user", "run command"),
      makeMessage("m2", 2, "assistant", "done"),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Bash",
        toolUseId: "tu-mixed-prefix",
        toolInput: { command: "echo hi && ls" },
      }, "m2"),
      makeEvent(1, "tool.finished", {
        toolName: "Bash",
        toolUseId: "tu-mixed-prefix",
        precedingToolUseIds: ["tu-mixed-prefix"],
        summary: "Ran echo hi && ls",
      }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const bashTools = items.filter((item) => item.kind === "tool" && item.shell === "bash");
    const exploreItems = items.filter((item) => item.kind === "explore-activity");

    expect(bashTools).toHaveLength(1);
    expect(exploreItems).toHaveLength(0);
  });

  it("keeps worktree diff events out of explore activity cards", () => {
    const messages = [
      makeMessage("m1", 1, "user", "delete file"),
      makeMessage("m2", 2, "assistant", "Deleted the top-level README."),
    ];
    const events = [
      makeEvent(0, "tool.finished", {
        source: "worktree.diff",
        summary: "Edited 1 file",
        changedFiles: ["README.md"],
        diff: "diff --git a/README.md b/README.md\n-Read the docs\n-find the repo\n",
      }, "m2"),
      makeEvent(1, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const exploreItems = items.filter((item) => item.kind === "explore-activity");
    const assistantMessages = items.filter((item) => item.kind === "message" && item.message.role === "assistant");

    expect(exploreItems).toHaveLength(0);
    expect(assistantMessages).toHaveLength(1);
  });

  it("keeps pure explore bash chains in subagent activity", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect files"),
      makeMessage("m2", 2, "assistant", "checking"),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Bash",
        toolUseId: "tu-explore",
        toolInput: { command: "ls && find . -name '*.ts'" },
      }, "m2"),
      makeEvent(1, "tool.finished", {
        toolName: "Bash",
        toolUseId: "tu-explore",
        precedingToolUseIds: ["tu-explore"],
        summary: "Ran ls && find . -name '*.ts'",
        output: "src/app.ts",
        error: null,
      }, "m2"),
      makeEvent(2, "message.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const bashTools = items.filter((item) => item.kind === "tool" && item.shell === "bash");
    const exploreItems = items.filter((item) => item.kind === "explore-activity");

    expect(exploreItems.length).toBeGreaterThan(0);
    expect(bashTools).toHaveLength(0);
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

  it("skips ACP fallback plan.created from rendering plan card", () => {
    const messages = [
      makeMessage("m1", 1, "user", "Plan"),
      makeMessage("m2", 2, "assistant", "Thinking"),
    ];
    const events = [
      makeEvent(0, "plan.created", {
        content: "# Plan\n\n[-] Investigate",
        filePath: ".claude/plans/acp-plan.md",
        source: "streaming_fallback",
      }, "m2"),
    ];

    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });

    const planItems = hookResult.items.filter((i) => i.kind === "plan-file-output");
    expect(planItems).toHaveLength(0);
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

  it("keeps stable subagent ids from running to finished states", () => {
    const messages = [makeMessage("m1", 1, "user", "Do"), makeMessage("m2", 2, "assistant", "Using agent")];
    const refs = makeRefs();
    const runningEvents = [
      makeEvent(0, "subagent.started", {
        toolUseId: "tu-stable",
        agentId: "agent-stable",
        agentType: "explore",
        description: "Searching code",
      }, "m2"),
    ];
    const finishedEvents = [
      ...runningEvents,
      makeEvent(1, "subagent.finished", {
        toolUseId: "tu-stable",
        agentId: "agent-stable",
        lastMessage: "Done",
      }, "m2"),
    ];

    act(() => {
      root.render(<TestComponent messages={messages} events={runningEvents} threadId="t1" refs={refs} />);
    });
    const runningItem = hookResult.items.find((item) => item.kind === "subagent-activity");
    expect(runningItem && runningItem.kind === "subagent-activity" ? runningItem.id : null).toBe("tu-stable");

    act(() => {
      root.render(<TestComponent messages={messages} events={finishedEvents} threadId="t1" refs={refs} />);
    });
    const finishedItem = hookResult.items.find((item) => item.kind === "subagent-activity");
    expect(finishedItem && finishedItem.kind === "subagent-activity" ? finishedItem.id : null).toBe("tu-stable");
  });

  it("keeps subagent-owned explore work out of top-level explore cards and backfills prompt from finish", () => {
    const messages = [
      makeMessage("m1", 1, "user", "Inspect the codebase"),
      makeMessage("m2", 2, "assistant", "Working on it"),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Task",
        toolUseId: "call-task-1",
      }, "m2"),
      makeEvent(1, "subagent.started", {
        toolUseId: "subagent-1",
        agentId: "agent-1",
        agentType: "Explore",
        description: "",
      }, "m2"),
      makeEvent(2, "tool.started", {
        toolName: "Read",
        toolUseId: "read-1",
        parentToolUseId: "subagent-1",
        toolInput: { file_path: "src/app.ts" },
      }, "m2"),
      makeEvent(3, "tool.finished", {
        toolName: "Read",
        toolUseId: "read-1-finished",
        precedingToolUseIds: ["read-1"],
        summary: "Read src/app.ts",
      }, "m2"),
      makeEvent(4, "tool.started", {
        toolName: "Glob",
        toolUseId: "glob-1",
        parentToolUseId: "subagent-1",
        searchParams: "src/**/*.ts",
      }, "m2"),
      makeEvent(5, "tool.finished", {
        toolName: "Glob",
        toolUseId: "glob-1-finished",
        precedingToolUseIds: ["glob-1"],
        summary: "Completed Glob",
      }, "m2"),
      makeEvent(6, "subagent.finished", {
        toolUseId: "subagent-1",
        description: "Inspect the codebase and report what you found",
        lastMessage: "Found the relevant files.",
      }, "m2"),
      makeEvent(7, "message.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const topLevelExplore = items.filter((item) => item.kind === "explore-activity");
    const subagentItems = items.filter((item) => item.kind === "subagent-activity");

    expect(topLevelExplore).toHaveLength(0);
    expect(subagentItems).toHaveLength(1);
    expect(subagentItems[0].kind === "subagent-activity" ? subagentItems[0].description : "").toBe(
      "Inspect the codebase and report what you found",
    );
    expect(subagentItems[0].kind === "subagent-activity" ? subagentItems[0].steps.length : 0).toBe(2);
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

  it("handles Read tool events for subagent activity", () => {
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
    expect(hookResult.hasIncompleteCoverage).toBe(true);
    expect(hookResult.summary.oldestRenderableMessageId).toBe("m1");
    expect(hookResult.summary.oldestRenderableHydrationPending).toBe(false);
  });

  it("marks coverage incomplete when the oldest loaded assistant is missing rich context on refresh", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", "assistant text before semantic context"),
    ];
    const events = [
      makeEvent(10, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} options={{ semanticHydrationInProgress: false }} />);
    });

    const assistantItem = hookResult.items.find((item) => item.kind === "message" && item.message.id === "m2");
    expect(assistantItem).toBeDefined();
    expect(hookResult.hasIncompleteCoverage).toBe(true);
    expect(hookResult.summary.oldestRenderableMessageId).toBe("m1");
  });

  it("recomputes prepend-only hydration changes so newly prepended items can render during hydration", () => {
    const refs = makeRefs();
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", "assistant text before semantic context"),
    ];
    const initialEvents = [
      makeEvent(10, "chat.completed", { messageId: "m2" }, "m2"),
    ];
    const prependedEvents = [
      makeEvent(5, "tool.finished", { toolName: "Read", summary: "Read /src/a.ts" }, "m2"),
      ...initialEvents,
    ];

    act(() => {
      root.render(<TestComponent messages={messages} events={initialEvents} threadId="t1" refs={refs} options={{ semanticHydrationInProgress: true }} />);
    });
    const previousResult = hookResult;
    const previousSummary = hookResult.summary;

    act(() => {
      root.render(<TestComponent messages={messages} events={prependedEvents} threadId="t1" refs={refs} options={{ semanticHydrationInProgress: true }} />);
    });

    expect(previousSummary.headIdentityStable).toBe(true);
    expect(hookResult).not.toBe(previousResult);
    expect(hookResult.summary).not.toBe(previousSummary);
    expect(hookResult.summary.headIdentityStable).toBe(false);
    expect(hookResult.summary.oldestRenderableKind).not.toBe("message");
    expect(hookResult.summary.oldestRenderableMessageId).toBeNull();
    expect(
      hookResult.items.some((item) => item.kind === "tool" || item.kind === "subagent-activity" || item.kind === "explore-activity"),
    ).toBe(true);
    expect(hookResult.items.some((item) => item.kind === "message" && item.message.id === "m1")).toBe(true);
  });

  it("renders overlapping subagents as separate cards without cross-claim", () => {
    const messages = [
      makeMessage("m1", 1, "user", "run overlapping tasks"),
      makeMessage("m2", 2, "assistant", "running"),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Task", toolUseId: "call_1" }, "m2"),
      makeEvent(2, "subagent.started", { toolUseId: "sa-1", agentId: "agent-1", agentType: "explore", description: "First" }, "m2"),
      makeEvent(3, "tool.started", { toolName: "Task", toolUseId: "call_2" }, "m2"),
      makeEvent(4, "subagent.started", { toolUseId: "sa-2", agentId: "agent-2", agentType: "explore", description: "Second" }, "m2"),
      makeEvent(5, "tool.started", { toolName: "Read", toolUseId: "child-a", parentToolUseId: "sa-1", summary: "Read /src/a.ts" }, "m2"),
      makeEvent(6, "tool.finished", { toolName: "Read", toolUseId: "child-a-done", precedingToolUseIds: ["child-a"], summary: "Read /src/a.ts" }, "m2"),
      makeEvent(7, "tool.started", { toolName: "Read", toolUseId: "child-b", parentToolUseId: "sa-2", summary: "Read /src/b.ts" }, "m2"),
      makeEvent(8, "tool.finished", { toolName: "Read", toolUseId: "child-b-done", precedingToolUseIds: ["child-b"], summary: "Read /src/b.ts" }, "m2"),
      makeEvent(9, "subagent.finished", { toolUseId: "sa-1", lastMessage: "done 1" }, "m2"),
      makeEvent(10, "subagent.finished", { toolUseId: "sa-2", lastMessage: "done 2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const subagentItems = items.filter((item) => item.kind === "subagent-activity");

    expect(subagentItems).toHaveLength(2);
    const first = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-1");
    const second = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-2");

    expect(first?.kind === "subagent-activity" ? first.steps.some((step) => step.label.includes("a.ts")) : false).toBe(true);
    expect(first?.kind === "subagent-activity" ? first.steps.some((step) => step.label.includes("b.ts")) : false).toBe(false);
    expect(second?.kind === "subagent-activity" ? second.steps.some((step) => step.label.includes("b.ts")) : false).toBe(true);
    expect(second?.kind === "subagent-activity" ? second.steps.some((step) => step.label.includes("a.ts")) : false).toBe(false);
  });

  it("extractSubagentExploreGroups quarantines overlap-unresolved events and marks them claimed", () => {
    const events = [
      makeEvent(1, "tool.started", { toolName: "Task", toolUseId: "call_1" }, "m2"),
      makeEvent(2, "subagent.started", { toolUseId: "sa-1", agentId: "agent-1", agentType: "explore", description: "First" }, "m2"),
      makeEvent(3, "tool.started", { toolName: "Task", toolUseId: "call_2" }, "m2"),
      makeEvent(4, "subagent.started", { toolUseId: "sa-2", agentId: "agent-2", agentType: "explore", description: "Second" }, "m2"),
      makeEvent(5, "tool.started", {
        toolName: "Read",
        toolUseId: "ambiguous-read",
        ownershipReason: "unresolved_overlap_no_lineage",
        activeSubagentToolUseIds: ["sa-1", "sa-2"],
      }, "m2"),
      makeEvent(6, "tool.finished", {
        toolName: "Read",
        toolUseId: "ambiguous-read-done",
        precedingToolUseIds: ["ambiguous-read"],
        summary: "Read maybe",
        ownershipReason: "unresolved_overlap_no_lineage",
        activeSubagentToolUseIds: ["sa-1", "sa-2"],
      }, "m2"),
      makeEvent(7, "subagent.finished", { toolUseId: "sa-1", lastMessage: "done 1" }, "m2"),
      makeEvent(8, "subagent.finished", { toolUseId: "sa-2", lastMessage: "done 2" }, "m2"),
    ];

    const extracted = extractSubagentExploreGroups(events);

    expect(extracted.exploreActivityGroups).toHaveLength(0);
    expect([...extracted.overlapUnclaimedEventIds]).toEqual(["e-5", "e-6"]);
    expect(extracted.claimedContextEventIds.has("e-5")).toBe(true);
    expect(extracted.claimedContextEventIds.has("e-6")).toBe(true);
    expect(extracted.unclaimedContextEventIds).toEqual([]);
  });

  it("quarantines overlap-unresolved tool events instead of routing them to explore activity", () => {
    pushRenderDebugMock.mockClear();
    const messages = [
      makeMessage("m1", 1, "user", "run overlapping tasks"),
      makeMessage("m2", 2, "assistant", "running"),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Task", toolUseId: "call_1" }, "m2"),
      makeEvent(2, "subagent.started", { toolUseId: "sa-1", agentId: "agent-1", agentType: "explore", description: "First" }, "m2"),
      makeEvent(3, "tool.started", { toolName: "Task", toolUseId: "call_2" }, "m2"),
      makeEvent(4, "subagent.started", { toolUseId: "sa-2", agentId: "agent-2", agentType: "explore", description: "Second" }, "m2"),
      makeEvent(5, "tool.started", {
        toolName: "Read",
        toolUseId: "ambiguous-read",
        ownershipReason: "unresolved_ambiguous_candidates",
        ownershipCandidates: ["sa-1", "sa-2"],
        activeSubagentToolUseIds: ["sa-1", "sa-2"],
      }, "m2"),
      makeEvent(6, "tool.finished", {
        toolName: "Read",
        toolUseId: "ambiguous-read-done",
        summary: "Read maybe",
        ownershipReason: "unresolved_ambiguous_candidates",
        ownershipCandidates: ["sa-1", "sa-2"],
        activeSubagentToolUseIds: ["sa-1", "sa-2"],
      }, "m2"),
      makeEvent(7, "subagent.finished", { toolUseId: "sa-1", lastMessage: "done 1" }, "m2"),
      makeEvent(8, "subagent.finished", { toolUseId: "sa-2", lastMessage: "done 2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const subagentItems = items.filter((item) => item.kind === "subagent-activity");
    const first = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-1");
    const second = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-2");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.kind === "subagent-activity" ? first.steps.some((step) => step.toolUseId.includes("ambiguous-read")) : false).toBe(false);
    expect(second?.kind === "subagent-activity" ? second.steps.some((step) => step.toolUseId.includes("ambiguous-read")) : false).toBe(false);

    const exploreItems = items.filter((item) => item.kind === "explore-activity");
    expect(exploreItems).toHaveLength(0);
    const orphanTool = items.find(
      (item) => item.kind === "tool" && item.toolUseId === "ambiguous-read",
    );
    expect(orphanTool).toBeUndefined();

    const debugEntries = pushRenderDebugMock.mock.calls
      .map(([entry]) => entry as { source?: string; event?: string; details?: Record<string, unknown> });

    const extractionDebugCalls = debugEntries
      .filter((entry) => entry.source === "useWorkspaceTimeline" && entry.event === "subagentExploreExtraction");
    expect(extractionDebugCalls.length).toBeGreaterThan(0);
    const lastExtraction = extractionDebugCalls[extractionDebugCalls.length - 1];
    const exploreEventIds = (lastExtraction.details?.exploreEventIds as string[] | undefined) ?? [];
    expect(exploreEventIds).not.toContain("e-5");

    const quarantinedEntries = debugEntries
      .filter((entry) => entry.source === "timelineOrphans" && entry.event === "quarantinedOverlapSubagentExploreEvents");
    expect(quarantinedEntries).toHaveLength(0);

    const unclaimedToolEvents = debugEntries
      .filter((entry) => entry.source === "subagentUtils" && entry.event === "unclaimedToolEvent")
      .map((entry) => entry.details as { eventId?: string; reasonCode?: string });
    expect(
      unclaimedToolEvents.some((entry) => entry.eventId === "e-5" && typeof entry.reasonCode === "string" && entry.reasonCode.startsWith("unclaimed_")),
    ).toBe(true);
  });

  it("keeps overlapping read events in subagent card when ownership arrives only on finish", () => {
    const messages = [
      makeMessage("m1", 1, "user", "run overlapping tasks"),
      makeMessage("m2", 2, "assistant", "running"),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Task", toolUseId: "call_1" }, "m2"),
      makeEvent(2, "subagent.started", { toolUseId: "sa-1", agentId: "agent-1", agentType: "explore", description: "First" }, "m2"),
      makeEvent(3, "tool.started", { toolName: "Task", toolUseId: "call_2" }, "m2"),
      makeEvent(4, "subagent.started", { toolUseId: "sa-2", agentId: "agent-2", agentType: "explore", description: "Second" }, "m2"),
      makeEvent(5, "tool.started", { toolName: "Read", toolUseId: "late-owned-read" }, "m2"),
      makeEvent(6, "tool.finished", {
        toolName: "Read",
        toolUseId: "late-owned-read-finished",
        precedingToolUseIds: ["late-owned-read"],
        summary: "Read src/a.ts",
        subagentOwnerToolUseId: "sa-1",
        launcherToolUseId: "call_1",
        ownershipReason: "resolved_tool_use_id",
      }, "m2"),
      makeEvent(7, "subagent.finished", { toolUseId: "sa-1", lastMessage: "done 1" }, "m2"),
      makeEvent(8, "subagent.finished", { toolUseId: "sa-2", lastMessage: "done 2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const exploreItems = items.filter((item) => item.kind === "explore-activity");
    expect(exploreItems).toHaveLength(0);

    const subagentItems = items.filter((item) => item.kind === "subagent-activity");
    const first = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-1");
    const second = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-2");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.kind === "subagent-activity" ? first.steps.some((step) => step.label.includes("a.ts")) : false).toBe(true);
    expect(second?.kind === "subagent-activity" ? second.steps.some((step) => step.label.includes("a.ts")) : false).toBe(false);
  });

  it("keeps concurrent subagent permission events inside subagent cards without top-level leaked bash cards", () => {
    const messages = [
      makeMessage("m1", 1, "user", "run overlapping tasks"),
      makeMessage("m2", 2, "assistant", "running"),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Task", toolUseId: "call_1" }, "m2"),
      makeEvent(2, "subagent.started", { toolUseId: "sa-1", agentId: "agent-1", agentType: "explore", description: "First" }, "m2"),
      makeEvent(3, "tool.started", { toolName: "Task", toolUseId: "call_2" }, "m2"),
      makeEvent(4, "subagent.started", { toolUseId: "sa-2", agentId: "agent-2", agentType: "explore", description: "Second" }, "m2"),
      makeEvent(5, "permission.requested", {
        requestId: "req-1",
        toolName: "Bash",
        command: "ls",
        subagentOwnerToolUseId: "sa-1",
        launcherToolUseId: "call_1",
      }, "m2"),
      makeEvent(6, "permission.resolved", {
        requestId: "req-1",
        decision: "deny",
        message: "Rejected 1",
        subagentOwnerToolUseId: "sa-1",
        launcherToolUseId: "call_1",
      }, "m2"),
      makeEvent(7, "permission.requested", {
        requestId: "req-2",
        toolName: "Bash",
        command: "pwd",
        subagentOwnerToolUseId: "sa-2",
        launcherToolUseId: "call_2",
      }, "m2"),
      makeEvent(8, "permission.resolved", {
        requestId: "req-2",
        decision: "deny",
        message: "Rejected 2",
        subagentOwnerToolUseId: "sa-2",
        launcherToolUseId: "call_2",
      }, "m2"),
      makeEvent(9, "subagent.finished", { toolUseId: "sa-1", lastMessage: "done 1" }, "m2"),
      makeEvent(10, "subagent.finished", { toolUseId: "sa-2", lastMessage: "done 2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const subagentItems = items.filter((item) => item.kind === "subagent-activity");
    const topLevelBash = items.filter((item) => item.kind === "tool" && item.shell === "bash");

    expect(subagentItems).toHaveLength(2);
    expect(topLevelBash).toHaveLength(0);

    const first = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-1");
    const second = subagentItems.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-2");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
  });

  it("keeps subagent explore-like bash finish events out of top-level bash cards when finished payload lacks toolName", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect repo"),
      makeMessage("m2", 2, "assistant", "running"),
    ];
    const events = [
      makeEvent(1, "subagent.started", { toolUseId: "sa-1", agentId: "agent-1", agentType: "explore", description: "Inspect repo" }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Bash", toolUseId: "bash-1", parentToolUseId: "sa-1", subagentOwnerToolUseId: "sa-1", command: "ls -la .github 2>/dev/null || echo \"No .github directory\"", shell: "bash", isBash: true }, "m2"),
      makeEvent(3, "tool.output", { toolName: "Bash", toolUseId: "bash-1", parentToolUseId: "sa-1", subagentOwnerToolUseId: "sa-1", elapsedTimeSeconds: 0.01 }, "m2"),
      makeEvent(4, "tool.finished", { precedingToolUseIds: ["bash-1"], summary: "Completed Bash", command: "ls -la .github 2>/dev/null || echo \"No .github directory\"", output: "No .github directory", shell: "bash", isBash: true }, "m2"),
      makeEvent(5, "subagent.finished", { toolUseId: "sa-1", lastMessage: "done" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const topLevelBash = items.filter((item) => item.kind === "tool" && item.shell === "bash");
    const subagent = items.find((item) => item.kind === "subagent-activity" && item.toolUseId === "sa-1");

    expect(topLevelBash).toHaveLength(0);
    expect(subagent && subagent.kind === "subagent-activity" ? subagent.steps.some((step) => step.label !== "Completed Bash") : false).toBe(true);
  });
});
