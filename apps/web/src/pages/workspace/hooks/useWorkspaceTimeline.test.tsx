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

  it("renders failed read summaries as tool items with failed-read labels", () => {
    const messages = [
      makeMessage("m1", 1, "user", "read package json"),
      makeMessage("m2", 2, "assistant", "Saya akan mencoba build aplikasi ini."),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Read",
        toolUseId: "read-1",
        toolInput: { file_path: "/tmp/project/package.json" },
      }, "m2"),
      makeEvent(1, "tool.finished", {
        precedingToolUseIds: ["read-1"],
        summary: "Failed to read /tmp/project/package.json",
      }, "m2"),
      makeEvent(2, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const toolItems = items.filter((item) => item.kind === "tool");

    expect(items.some((item) => item.kind === "tool" || item.kind === "message")).toBe(true);
    expect(toolItems).toHaveLength(1);
    if (toolItems[0]?.kind !== "tool") {
      throw new Error("Expected tool item");
    }
    expect(toolItems[0].summary).toContain("Failed to read");
  });

  it("coalesces orphan skill events into a single skill tool item", () => {
    const messages = [makeMessage("m1", 1, "user", "anything")];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Skill",
        toolUseId: "call-skill-1",
        skillName: "finly-pull-request",
      }, null),
      makeEvent(1, "tool.finished", {
        summary: "Completed Skill",
        precedingToolUseIds: ["call-skill-1"],
        skillName: "finly-pull-request",
      }, null),
    ];

    const items = getTimelineItems(messages, events);
    const toolItems = items.filter((item) => item.kind === "tool");
    const skillItems = toolItems.filter((item) => item.kind === "tool" && item.toolName === "Skill");

    const debugEntries = pushRenderDebugMock.mock.calls
      .map(([entry]) => entry as { source?: string; event?: string; details?: Record<string, unknown> });

    expect(skillItems).toHaveLength(1);
    expect(debugEntries.some((entry) => entry.source === "timelineOrphans" && entry.event === "coalescedSkillToolRun")).toBe(true);
    if (skillItems[0]?.kind !== "tool") {
      throw new Error("Expected tool item");
    }
    expect(skillItems[0].summary).toBe("Using finly-pull-request skill");
    expect(skillItems[0].event?.type).toBe("tool.finished");
  });

  it("renders ls-based build checks as normal tool items, not explore activity", () => {
    const messages = [
      makeMessage("m1", 1, "user", "build app"),
      makeMessage("m2", 2, "assistant", "Saya akan mencoba build aplikasi ini. Ini adalah project Android. Saya bisa melihat file gradlew untuk build. Mari saya coba build dengan Gradle:"),
    ];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Bash",
        toolUseId: "ls-1",
        toolInput: { command: "ls -la" },
        command: "ls -la",
      }, "m2"),
      makeEvent(1, "tool.finished", {
        precedingToolUseIds: ["ls-1"],
        summary: "Ran ls -la",
        command: "ls -la",
      }, "m2"),
      makeEvent(2, "tool.started", {
        toolName: "Bash",
        toolUseId: "gradle-1",
        toolInput: { command: "./gradlew assembleDebug" },
        command: "./gradlew assembleDebug",
      }, "m2"),
      makeEvent(3, "tool.finished", {
        precedingToolUseIds: ["gradle-1"],
        summary: "Ran ./gradlew assembleDebug",
        command: "./gradlew assembleDebug",
      }, "m2"),
      makeEvent(4, "tool.started", {
        toolName: "Bash",
        toolUseId: "ls-2",
        toolInput: { command: "ls -lh app/build/outputs/apk/debug/" },
        command: "ls -lh app/build/outputs/apk/debug/",
      }, "m2"),
      makeEvent(5, "tool.finished", {
        precedingToolUseIds: ["ls-2"],
        summary: "Ran ls -lh app/build/outputs/apk/debug/",
        command: "ls -lh app/build/outputs/apk/debug/",
      }, "m2"),
      makeEvent(6, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const bashTools = items.filter((item) => item.kind === "tool" && item.shell === "bash");
    const exploreItems = items.filter((item) => item.kind === "explore-activity");

    expect(bashTools.length).toBeGreaterThanOrEqual(3);
    expect(exploreItems).toHaveLength(0);
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

  it("renders orphan write start as edited-diff instead of generic tool", () => {
    const messages = [makeMessage("m1", 1, "user", "Fix"), makeMessage("m2", 2, "assistant", "Editing...")];
    const events = [
      makeEvent(0, "tool.started", {
        toolName: "Write",
        toolUseId: "tu-write-1",
        toolInput: {
          file_path: "/tmp/test/main_tab_page_test.dart",
          content: "hello world",
        },
      }, null),
    ];

    const items = getTimelineItems(messages, events);
    const editedItems = items.filter((item) => item.kind === "edited-diff");
    const genericToolItems = items.filter((item) => item.kind === "tool");

    expect(editedItems).toHaveLength(1);
    expect(genericToolItems).toHaveLength(0);
    if (editedItems[0]?.kind !== "edited-diff") {
      throw new Error("Expected edited-diff item");
    }
    expect(editedItems[0].status).toBe("running");
    expect(editedItems[0].changedFiles).toContain("/tmp/test/main_tab_page_test.dart");
    expect(editedItems[0].diffKind).toBe("proposed");
  });

  it("keeps read activity grouped before assistant text when text arrives after the read", () => {
    const messages = [
      makeMessage("m1", 1, "user", "Think"),
      makeMessage("m2", 2, "assistant", "Checking the codebase."),
    ];
    const events = [
      makeEvent(0, "tool.started", { toolName: "Read", toolUseId: "read-1", toolInput: { file_path: "src/app.ts" } }, "m2"),
      makeEvent(1, "tool.finished", { toolName: "Read", toolUseId: "read-1", summary: "Read src/app.ts", precedingToolUseIds: ["read-1"] }, "m2"),
      makeEvent(2, "message.delta", { role: "assistant", messageId: "m2", delta: "Checking the codebase." }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const firstMessageIndex = hookResult.items.findIndex((item) => item.kind === "message" && item.message.role === "assistant");
    const firstExploreIndex = hookResult.items.findIndex((item) => item.kind === "explore-activity");
    expect(firstExploreIndex).toBeGreaterThan(-1);
    expect(firstMessageIndex).toBeGreaterThan(-1);
    expect(firstExploreIndex).toBeLessThan(firstMessageIndex);
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
      makeEvent(0, "plan.created", { messageId: "m2", content: "# My Plan", filePath: ".claude/plans/my-plan.md" }, "m2"),
    ];
    act(() => {
      root.render(<TestComponent messages={messages} events={events} threadId="t1" refs={makeRefs()} />);
    });
    const planItems = hookResult.items.filter((i) => i.kind === "plan-file-output");
    expect(planItems).toHaveLength(1);
  });

  it("skips bogus streaming fallback plan events without a real plan write", () => {
    const messages = [makeMessage("m1", 1, "user", "hi"), makeMessage("m2", 2, "assistant", "Hello there")];
    const events = [
      makeEvent(0, "plan.created", {
        messageId: "m2",
        content: "Hello there",
        filePath: "streaming-plan",
        source: "streaming_fallback",
      }, "m2"),
      makeEvent(1, "chat.completed", {}, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    expect(items.filter((i) => i.kind === "plan-file-output")).toHaveLength(0);
  });

  it("renders the real plan content for streaming fallback backed by a real write", () => {
    const messages = [makeMessage("m1", 1, "user", "plan it"), makeMessage("m2", 2, "assistant", "Drafting")];
    const events = [
      makeEvent(0, "plan.created", {
        messageId: "m2",
        content: "Drafting",
        filePath: "streaming-plan",
        source: "streaming_fallback",
      }, "m2"),
      makeEvent(1, "tool.finished", {
        editTarget: ".claude/plans/real-plan.md",
        toolInput: { content: "# Real Plan\n- Step 1" },
      }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const planItems = items.filter((i) => i.kind === "plan-file-output");
    expect(planItems).toHaveLength(1);
    expect(planItems[0]).toMatchObject({
      content: "# Real Plan\n- Step 1",
      filePath: ".claude/plans/real-plan.md",
    });
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

  it("keeps fallback-anchored explore and edit cards with their assistant turn instead of drifting to the tail", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect"),
      makeMessage("m2", 2, "assistant", "I checked and updated the UI."),
      makeMessage("m3", 3, "user", "thanks"),
      makeMessage("m4", 4, "assistant", "done"),
    ];
    const events = [
      makeEvent(50, "tool.started", { toolName: "Glob", toolUseId: "g1", searchParams: "src/**/*.ts" }, "m2"),
      makeEvent(51, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] }, "m2"),
      makeEvent(52, "tool.started", { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "src/app.ts", old_string: "a", new_string: "b" } }, "m2"),
      makeEvent(53, "tool.finished", { toolName: "Edit", summary: "Updated src/app.ts", precedingToolUseIds: ["e1"], changedFiles: ["src/app.ts"], additions: 1, deletions: 1 }, "m2"),
      makeEvent(54, "message.delta", { role: "assistant", messageId: "m2", delta: "I checked and updated the UI." }, "m2"),
      makeEvent(200, "message.delta", { role: "assistant", messageId: "m4", delta: "done" }, "m4"),
      makeEvent(201, "chat.completed", { messageId: "m4" }, "m4"),
    ];

    const items = getTimelineItems(messages, events);
    const exploreIndex = items.findIndex((item) => item.kind === "explore-activity");
    const editedIndex = items.findIndex((item) => item.kind === "edited-diff");
    const laterAssistantIndex = items.findIndex((item) => item.kind === "message" && item.message.id === "m4");

    expect(exploreIndex).toBeGreaterThan(-1);
    expect(editedIndex).toBeGreaterThan(-1);
    expect(laterAssistantIndex).toBeGreaterThan(-1);
    expect(exploreIndex).toBeLessThan(laterAssistantIndex);
    expect(editedIndex).toBeLessThan(laterAssistantIndex);
    expect(exploreIndex).toBeLessThan(editedIndex);
  });

  it("keeps an assistant read-confirmation sentence ahead of a later edit card even when the sentence spans the edit boundary", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect and edit"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "Saya akan membaca kedua file tersebut dan melakukan beberapa edit kecil yang tidak berbahaya.Baik, saya sudah membaca kedua file tersebut. Sekarang saya akan melakukan edit kecil.",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "Saya akan membaca kedua file tersebut dan melakukan beberapa edit kecil yang tidak berbahaya." }, "m2"),
      makeEvent(10, "tool.started", { toolName: "Glob", toolUseId: "g1", searchParams: "**/README.md" }, "m2"),
      makeEvent(11, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] }, "m2"),
      makeEvent(12, "tool.started", { toolName: "Read", toolUseId: "r1", toolInput: { file_path: "README.md" } }, "m2"),
      makeEvent(13, "tool.finished", { toolName: "Read", summary: "Read README.md", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(14, "message.delta", { role: "assistant", messageId: "m2", delta: "Baik" }, "m2"),
      makeEvent(20, "tool.started", { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "README.md", old_string: "a", new_string: "b" } }, "m2"),
      makeEvent(21, "tool.finished", { toolName: "Edit", summary: "Edited README.md", editTarget: "README.md", precedingToolUseIds: ["e1"], changedFiles: ["README.md"], additions: 6, deletions: 5 }, "m2"),
      makeEvent(22, "message.delta", { role: "assistant", messageId: "m2", delta: ", saya sudah membaca kedua file tersebut. Sekarang saya akan melakukan edit kecil." }, "m2"),
      makeEvent(23, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const exploreIndex = items.findIndex((item) => item.kind === "explore-activity");
    const confirmationIndex = items.findIndex(
      (item) =>
        item.kind === "message"
        && item.message.content.includes("Baik, saya sudah membaca kedua file tersebut."),
    );
    const editedIndex = items.findIndex((item) => item.kind === "edited-diff");

    expect(exploreIndex).toBeGreaterThan(-1);
    expect(confirmationIndex).toBeGreaterThan(-1);
    expect(editedIndex).toBeGreaterThan(-1);
    expect(exploreIndex).toBeLessThan(confirmationIndex);
    expect(confirmationIndex).toBeLessThan(editedIndex);
  });

  it("keeps a short pre-edit fragment with the preceding announcement instead of merging it into post-edit completion text", () => {
    const messages = [
      makeMessage("m1", 1, "user", "inspect and edit"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "Saya akan membaca kedua file tersebut terlebih dahulu. Baik, saya akan membuat perubahan tidak berbahaya pada kedua file tersebut. Mari saya edit:Selesai!",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "Saya akan membaca kedua file tersebut terlebih dahulu." }, "m2"),
      makeEvent(10, "tool.started", { toolName: "Glob", toolUseId: "g1", searchParams: "**/README.md" }, "m2"),
      makeEvent(11, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] }, "m2"),
      makeEvent(12, "tool.started", { toolName: "Read", toolUseId: "r1", toolInput: { file_path: "README.md" } }, "m2"),
      makeEvent(13, "tool.finished", { toolName: "Read", summary: "Read README.md", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(14, "message.delta", { role: "assistant", messageId: "m2", delta: "Baik, saya akan membuat perubahan tidak berbahaya pada kedua file tersebut. Mari saya" }, "m2"),
      makeEvent(20, "tool.started", { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "README.md", old_string: "a", new_string: "b" } }, "m2"),
      makeEvent(21, "tool.finished", { toolName: "Edit", summary: "Edited README.md", editTarget: "README.md", precedingToolUseIds: ["e1"], changedFiles: ["README.md"], additions: 5, deletions: 4 }, "m2"),
      makeEvent(22, "message.delta", { role: "assistant", messageId: "m2", delta: " edit:" }, "m2"),
      makeEvent(23, "tool.started", { toolName: "Edit", toolUseId: "e2", toolInput: { file_path: "build.gradle", old_string: "a", new_string: "b" } }, "m2"),
      makeEvent(24, "tool.finished", { toolName: "Edit", summary: "Edited build.gradle", editTarget: "build.gradle", precedingToolUseIds: ["e2"], changedFiles: ["build.gradle"], additions: 5, deletions: 0 }, "m2"),
      makeEvent(25, "message.delta", { role: "assistant", messageId: "m2", delta: "Selesai! Saya telah melakukan perubahan tidak berbahaya pada kedua file:" }, "m2"),
      makeEvent(26, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const firstEditedIndex = items.findIndex((item) => item.kind === "edited-diff" && item.changedFiles.includes("README.md"));
    const secondEditedIndex = items.findIndex((item) => item.kind === "edited-diff" && item.changedFiles.includes("build.gradle"));
    const preSecondEditMessageIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Mari saya edit:"),
    );
    const doneMessageIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Selesai!"),
    );

    expect(firstEditedIndex).toBeGreaterThan(-1);
    expect(secondEditedIndex).toBeGreaterThan(-1);
    expect(preSecondEditMessageIndex).toBeGreaterThan(-1);
    expect(doneMessageIndex).toBeGreaterThan(-1);
    expect(firstEditedIndex).toBeLessThan(preSecondEditMessageIndex);
    expect(preSecondEditMessageIndex).toBeLessThan(secondEditedIndex);
    expect(secondEditedIndex).toBeLessThan(doneMessageIndex);
  });

  it("strips leaked think tags and keeps post-edit completion text after both edit cards", () => {
    const messages = [
      makeMessage("m1", 1, "user", "update harmless edit"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "Sip, saya akan buat edit kecil/bebas di kedua file tersebut.</think>Selesai! Saya telah melakukan edit kecil/harmless di kedua file:\n\n1. **README.md** - Menambahkan komentar `<!-- Minor update applied -->`\n2. **build.gradle** - Menambahkan komentar `// Build sync completed`",
      ),
    ];
    const events = [
      makeEvent(1, "tool.started", { toolName: "Glob", toolUseId: "g1", searchParams: "pattern=**/README.md" }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Glob", toolUseId: "g2", searchParams: "pattern=**/build.gradle" }, "m2"),
      makeEvent(3, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"], searchParams: "pattern=**/README.md" }, "m2"),
      makeEvent(4, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g2"], searchParams: "pattern=**/build.gradle" }, "m2"),
      makeEvent(5, "tool.started", { toolName: "Read", toolUseId: "r1", toolInput: { file_path: "/repo/README.md" } }, "m2"),
      makeEvent(6, "tool.started", { toolName: "Read", toolUseId: "r2", toolInput: { file_path: "/repo/build.gradle" } }, "m2"),
      makeEvent(7, "tool.finished", { toolName: "Read", summary: "Read /repo/README.md", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(8, "tool.finished", { toolName: "Read", summary: "Read /repo/build.gradle", precedingToolUseIds: ["r2"] }, "m2"),
      makeEvent(9, "message.delta", { role: "assistant", messageId: "m2", delta: "Sip, saya akan buat edit kecil/bebas di kedua file tersebut." }, "m2"),
      makeEvent(10, "message.delta", { role: "assistant", messageId: "m2", delta: "</think>" }, "m2"),
      makeEvent(11, "tool.started", { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "/repo/README.md", old_string: "a", new_string: "b" } }, "m2"),
      makeEvent(29, "tool.finished", { toolName: "Edit", summary: "Edited /repo/README.md", precedingToolUseIds: ["e1"], editTarget: "/repo/README.md" }, "m2"),
      makeEvent(30, "tool.started", { toolName: "Edit", toolUseId: "e2", toolInput: { file_path: "/repo/build.gradle", old_string: "x", new_string: "y" } }, "m2"),
      makeEvent(31, "tool.finished", { toolName: "Edit", summary: "Edited /repo/build.gradle", precedingToolUseIds: ["e2"], editTarget: "/repo/build.gradle" }, "m2"),
      makeEvent(32, "message.delta", { role: "assistant", messageId: "m2", delta: "Selesai! Saya telah melakukan edit kecil/harmless di kedua file:\n\n1. **README.md** - Menambahkan komentar `<!-- Minor update applied -->`\n2. **build.gradle** - Menambahkan komentar `// Build sync completed`" }, "m2"),
      makeEvent(105, "tool.finished", {
        source: "worktree.diff",
        summary: "Edited 2 files",
        changedFiles: ["README.md", "build.gradle"],
        diff: [
          "diff --git a/README.md b/README.md",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "diff --git a/build.gradle b/build.gradle",
          "--- a/build.gradle",
          "+++ b/build.gradle",
          "@@ -1 +1 @@",
          "-x",
          "+y",
        ].join("\n"),
      }, "m2"),
      makeEvent(106, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const allAssistantText = items
      .filter((item) => item.kind === "message" && item.message.role === "assistant")
      .map((item) => item.message.content)
      .join("\n");
    const introIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Sip, saya akan buat edit kecil/bebas di kedua file tersebut."),
    );
    const completionIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Selesai!"),
    );
    const summaryTailIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("README.md"),
    );
    const readmeEditIndex = items.findIndex(
      (item) => item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("README.md")),
    );
    const gradleEditIndex = items.findIndex(
      (item) => item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("build.gradle")),
    );

    expect(allAssistantText).not.toContain("</think>");
    expect(introIndex).toBeGreaterThan(-1);
    expect(readmeEditIndex).toBeGreaterThan(-1);
    expect(gradleEditIndex).toBeGreaterThan(-1);
    expect(completionIndex).toBeGreaterThan(-1);
    expect(summaryTailIndex).toBeGreaterThan(-1);
    expect(introIndex).toBeLessThan(readmeEditIndex);
    expect(readmeEditIndex).toBeLessThan(gradleEditIndex);
    expect(gradleEditIndex).toBeLessThan(completionIndex);
    expect(summaryTailIndex).toBeGreaterThanOrEqual(completionIndex);
    expect(items[readmeEditIndex]).toMatchObject({ kind: "edited-diff", diffKind: "actual" });
    expect(items[gradleEditIndex]).toMatchObject({ kind: "edited-diff", diffKind: "actual" });
  });

  it("keeps a colon-terminated pre-edit clause ahead of the first edit card instead of splitting it across the edit", () => {
    const messages = [
      makeMessage("m1", 1, "user", "edit two files"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "I'll make some harmless edits to both files. Let me first read them. Now let me make some harmless edits to both files:Done!",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "I'll make some harmless edits to both files. " }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Read", toolUseId: "r1", toolInput: { file_path: "/repo/README.md" } }, "m2"),
      makeEvent(3, "tool.finished", { toolName: "Read", summary: "Read /repo/README.md", precedingToolUseIds: ["r1"] }, "m2"),
      makeEvent(4, "message.delta", { role: "assistant", messageId: "m2", delta: "Let me first read them. Now let me" }, "m2"),
      makeEvent(5, "tool.started", { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "/repo/README.md", old_string: "a", new_string: "b" } }, "m2"),
      makeEvent(6, "message.delta", { role: "assistant", messageId: "m2", delta: " make some harmless edits to both files:" }, "m2"),
      makeEvent(7, "tool.finished", { toolName: "Edit", summary: "Edited /repo/README.md", precedingToolUseIds: ["e1"], editTarget: "/repo/README.md" }, "m2"),
      makeEvent(8, "tool.started", { toolName: "Edit", toolUseId: "e2", toolInput: { file_path: "/repo/build.gradle", old_string: "x", new_string: "y" } }, "m2"),
      makeEvent(9, "tool.finished", { toolName: "Edit", summary: "Edited /repo/build.gradle", precedingToolUseIds: ["e2"], editTarget: "/repo/build.gradle" }, "m2"),
      makeEvent(10, "message.delta", { role: "assistant", messageId: "m2", delta: "Done!" }, "m2"),
      makeEvent(11, "tool.finished", {
        source: "worktree.diff",
        changedFiles: ["README.md", "build.gradle"],
        diff: [
          "diff --git a/README.md b/README.md",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "diff --git a/build.gradle b/build.gradle",
          "--- a/build.gradle",
          "+++ b/build.gradle",
          "@@ -1 +1 @@",
          "-x",
          "+y",
        ].join("\n"),
      }, "m2"),
      makeEvent(12, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const clauseIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Now let me make some harmless edits to both files:"),
    );
    const firstEditedIndex = items.findIndex(
      (item) => item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("README.md")),
    );

    expect(clauseIndex).toBeGreaterThan(-1);
    expect(firstEditedIndex).toBeGreaterThan(-1);
    expect(clauseIndex).toBeLessThan(firstEditedIndex);
  });

  it("keeps a single-edit completion message after the edit card when the edit starts mid-sentence", () => {
    const messages = [
      makeMessage("m1", 1, "user", "yaa perbaiki"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "Baik, saya akan memperbaiki kode tersebut sekarang.Sip! Perbaikan sudah dilakukan.\n\n**Apa yang berubah:**\n\nMetode `openSupportEmail()` sekarang menggunakan `Uri.Builder`.",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "Baik, saya akan" }, "m2"),
      makeEvent(2, "tool.started", {
        toolName: "Edit",
        toolUseId: "e1",
        toolInput: { file_path: "/repo/OTPLoginActivity.java", old_string: "a", new_string: "b" },
      }, "m2"),
      makeEvent(3, "message.delta", { role: "assistant", messageId: "m2", delta: " memperbaiki kode tersebut sekarang." }, "m2"),
      makeEvent(4, "tool.finished", {
        toolName: "Edit",
        summary: "Edited /repo/OTPLoginActivity.java",
        precedingToolUseIds: ["e1"],
        editTarget: "/repo/OTPLoginActivity.java",
      }, "m2"),
      makeEvent(5, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "Sip! Perbaikan sudah dilakukan.\n\n**Apa yang berubah:**\n\nMetode `openSupportEmail()` sekarang menggunakan `Uri.Builder`.",
      }, "m2"),
      makeEvent(6, "tool.finished", {
        source: "worktree.diff",
        changedFiles: ["/repo/OTPLoginActivity.java"],
        diff: [
          "diff --git a/OTPLoginActivity.java b/OTPLoginActivity.java",
          "--- a/OTPLoginActivity.java",
          "+++ b/OTPLoginActivity.java",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      }, "m2"),
      makeEvent(7, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const introIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Baik, saya akan memperbaiki kode tersebut sekarang."),
    );
    const editIndex = items.findIndex(
      (item) => item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("OTPLoginActivity.java")),
    );
    const completionIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Sip! Perbaikan sudah dilakukan."),
    );

    expect(introIndex).toBeGreaterThan(-1);
    expect(editIndex).toBeGreaterThan(-1);
    expect(completionIndex).toBeGreaterThan(-1);
    expect(introIndex).toBeLessThan(editIndex);
    expect(editIndex).toBeLessThan(completionIndex);
  });

  it("keeps a search announcement ahead of explore activity when the search starts mid-sentence", () => {
    const messages = [
      makeMessage("m1", 1, "user", "cek activity otp"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "Sekarang mari saya cari Activity Kotlin/Java yang menangani klik tombol bantuan tersebut:Saya menemukan masalahnya!",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "Sekarang mari saya cari Activity Kotlin/" }, "m2"),
      makeEvent(2, "tool.started", { toolName: "Glob", toolUseId: "g1", searchParams: "pattern=**/*OTPLogin*.{kt,java}" }, "m2"),
      makeEvent(3, "tool.started", { toolName: "Grep", toolUseId: "g2", searchParams: "pattern=button_no_otp_help" }, "m2"),
      makeEvent(4, "message.delta", { role: "assistant", messageId: "m2", delta: "Java yang menangani klik tombol bantuan tersebut:" }, "m2"),
      makeEvent(5, "tool.finished", { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] }, "m2"),
      makeEvent(6, "tool.finished", { toolName: "Grep", summary: "Completed Grep", precedingToolUseIds: ["g2"] }, "m2"),
      makeEvent(7, "message.delta", { role: "assistant", messageId: "m2", delta: "Saya menemukan masalahnya!" }, "m2"),
      makeEvent(8, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const announcementIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Sekarang mari saya cari Activity Kotlin/Java yang menangani klik tombol bantuan tersebut:"),
    );
    const exploreIndex = items.findIndex((item) => item.kind === "explore-activity");
    const diagnosisIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Saya menemukan masalahnya!"),
    );

    expect(announcementIndex).toBeGreaterThan(-1);
    expect(exploreIndex).toBeGreaterThan(-1);
    expect(diagnosisIndex).toBeGreaterThan(-1);
    expect(announcementIndex).toBeLessThan(exploreIndex);
    expect(exploreIndex).toBeLessThan(diagnosisIndex);
  });

  it("keeps a carried pre-edit sentence ahead of the edit card when an earlier apology sentence already completed before the edit starts", () => {
    const messages = [
      makeMessage("m1", 1, "user", "email To nya kok malah tidak terisi otomatis?"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "Ah iya, maaf! Ada masalah dengan email To-nya. Mari saya perbaiki lagi:Sip sudah diperbaiki! ✅",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "Ah iya" }, "m2"),
      makeEvent(2, "message.delta", { role: "assistant", messageId: "m2", delta: ", maaf!" }, "m2"),
      makeEvent(3, "tool.started", {
        toolName: "Edit",
        toolUseId: "e1",
        toolInput: { file_path: "/repo/OTPLoginActivity.java", old_string: "a", new_string: "b" },
      }, "m2"),
      makeEvent(4, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: " Ada masalah dengan email To-nya. Mari saya perbaiki lagi:",
      }, "m2"),
      makeEvent(5, "tool.finished", {
        toolName: "Edit",
        summary: "Edited /repo/OTPLoginActivity.java",
        precedingToolUseIds: ["e1"],
        editTarget: "/repo/OTPLoginActivity.java",
      }, "m2"),
      makeEvent(6, "message.delta", { role: "assistant", messageId: "m2", delta: "Sip sudah diperbaiki! ✅" }, "m2"),
      makeEvent(7, "tool.finished", {
        source: "worktree.diff",
        changedFiles: ["/repo/OTPLoginActivity.java"],
        diff: [
          "diff --git a/OTPLoginActivity.java b/OTPLoginActivity.java",
          "--- a/OTPLoginActivity.java",
          "+++ b/OTPLoginActivity.java",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      }, "m2"),
      makeEvent(8, "chat.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const apologyIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Ah iya, maaf!"),
    );
    const issueIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Ada masalah dengan email To-nya."),
    );
    const announcementIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Mari saya perbaiki lagi:"),
    );
    const editIndex = items.findIndex(
      (item) => item.kind === "edited-diff" && item.changedFiles.some((file) => file.includes("OTPLoginActivity.java")),
    );
    const completionIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Sip sudah diperbaiki!"),
    );

    expect(apologyIndex).toBeGreaterThan(-1);
    expect(issueIndex).toBeGreaterThan(-1);
    expect(announcementIndex).toBeGreaterThan(-1);
    expect(editIndex).toBeGreaterThan(-1);
    expect(completionIndex).toBeGreaterThan(-1);
    expect(apologyIndex).toBeLessThanOrEqual(issueIndex);
    expect(issueIndex).toBeLessThanOrEqual(announcementIndex);
    expect(announcementIndex).toBeLessThan(editIndex);
    expect(editIndex).toBeLessThan(completionIndex);
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

  it("keeps trailing build summary text after a finished bash card without head-tail inversion", () => {
    const messages = [
      makeMessage("m1", 1, "user", "coba check apakah build berhasil?"),
      makeMessage(
        "m2",
        2,
        "assistant",
        "Baik, saya akan cek apakah build berhasil:✅ **BUILD SUCCESSFUL!**\n\nBuild berhasil dalam 1 menit 57 detik. Tidak ada error sama sekali, hanya beberapa warnings tentang deprecated API dan unused parameters yang tidak mempengaruhi fungsi aplikasi.\n\nSekarang perbaikan email di halaman OTP login sudah selesai dan siap digunakan! 📧",
      ),
    ];
    const events = [
      makeEvent(1, "message.delta", { role: "assistant", messageId: "m2", delta: "Baik, saya akan c" }, "m2"),
      makeEvent(2, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-build",
        command: "./gradlew assembleDebug 2>&1 | tail -50",
        shell: "bash",
        isBash: true,
      }, "m2"),
      makeEvent(3, "tool.finished", {
        toolName: "Bash",
        toolUseId: "bash-build",
        precedingToolUseIds: ["bash-build"],
        summary: "Ran ./gradlew assembleDebug 2>&1 | tail -50",
        command: "./gradlew assembleDebug 2>&1 | tail -50",
        shell: "bash",
        isBash: true,
        output: "BUILD SUCCESSFUL",
      }, "m2"),
      makeEvent(4, "message.delta", {
        role: "assistant",
        messageId: "m2",
        delta: "ek apakah build berhasil:✅ **BUILD SUCCESSFUL!**\n\nBuild berhasil dalam 1 menit 57 detik. Tidak ada error sama sekali, hanya beberapa warnings tentang deprecated API dan unused parameters yang tidak mempengaruhi fungsi aplikasi.\n\nSekarang perbaikan email di halaman OTP login sudah selesai dan siap digunakan! 📧",
      }, "m2"),
      makeEvent(5, "message.completed", { messageId: "m2" }, "m2"),
    ];

    const items = getTimelineItems(messages, events);
    const buildIntroIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Build berhasil dalam 1 menit 57 detik."),
    );
    const toolIndex = items.findIndex(
      (item) => item.kind === "tool" && item.summary === "Ran ./gradlew assembleDebug 2>&1 | tail -50",
    );
    const warningIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Tidak ada error sama sekali"),
    );
    const summaryIndex = items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Sekarang perbaikan email di halaman OTP login sudah selesai"),
    );

    expect(buildIntroIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(warningIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(buildIntroIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(warningIndex);
    expect(warningIndex).toBeLessThan(summaryIndex);
  });
});
