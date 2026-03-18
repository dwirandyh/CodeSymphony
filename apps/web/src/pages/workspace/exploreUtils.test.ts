import { describe, it, expect } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import {
  shortenReadTargetForDisplay,
  extractReadTargetFromSummary,
  extractReadFileEntry,
  normalizeSearchSummary,
  searchContextFromEvent,
  buildSearchRunningLabel,
  buildSearchCompletedFallbackLabel,
  extractSearchEntryLabel,
  extractExploreRunKind,
  extractExploreActivityGroups,
} from "./exploreUtils";

function makeEvent(overrides: Partial<ChatEvent> & { type: ChatEvent["type"] }): ChatEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    idx: 0,
    payload: {},
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("shortenReadTargetForDisplay", () => {
  it("returns basename for absolute path", () => {
    expect(shortenReadTargetForDisplay("/home/user/project/src/index.ts")).toBe("index.ts");
  });

  it("returns parent/basename for dotfile parent", () => {
    expect(shortenReadTargetForDisplay("/project/.github/ci.yml")).toBe(".github/ci.yml");
  });

  it("strips quotes", () => {
    expect(shortenReadTargetForDisplay('"src/index.ts"')).toBe("index.ts");
    expect(shortenReadTargetForDisplay("'src/app.ts'")).toBe("app.ts");
  });

  it("handles Windows-style paths", () => {
    expect(shortenReadTargetForDisplay("C:\\Users\\me\\file.ts")).toBe("file.ts");
  });

  it("strips line number suffixes", () => {
    expect(shortenReadTargetForDisplay("/src/file.ts:42")).toBe("file.ts");
    expect(shortenReadTargetForDisplay("/src/file.ts:42:10")).toBe("file.ts");
  });

  it("strips trailing slashes", () => {
    expect(shortenReadTargetForDisplay("/src/dir/")).toBe("dir");
  });

  it("returns cleaned input for single segment", () => {
    expect(shortenReadTargetForDisplay("file.ts")).toBe("file.ts");
  });
});

describe("extractReadTargetFromSummary", () => {
  it("extracts target from Read summary", () => {
    expect(extractReadTargetFromSummary("Read /src/index.ts")).toBe("/src/index.ts");
  });

  it("extracts from Opened summary", () => {
    expect(extractReadTargetFromSummary("Opened /src/app.ts")).toBe("/src/app.ts");
  });

  it("extracts from Cat summary", () => {
    expect(extractReadTargetFromSummary("Cat file.ts")).toBe("file.ts");
  });

  it("returns null for 'Completed Read'", () => {
    expect(extractReadTargetFromSummary("Completed Read")).toBeNull();
  });

  it("returns null for empty after stripping prefix", () => {
    expect(extractReadTargetFromSummary("Read ")).toBeNull();
  });

  it("strips quotes from extracted target", () => {
    expect(extractReadTargetFromSummary('Read "file.ts"')).toBe("file.ts");
  });
});

describe("extractReadFileEntry", () => {
  it("extracts entry from event with summary", () => {
    const event = makeEvent({ type: "tool.finished", payload: { summary: "Read /src/file.ts" } });
    const entry = extractReadFileEntry(event);
    expect(entry?.label).toBe("file.ts");
    expect(entry?.openPath).toBe("/src/file.ts");
  });

  it("returns generic entry for 'Completed Read' summary", () => {
    const event = makeEvent({ type: "tool.finished", payload: { summary: "Completed Read" } });
    const entry = extractReadFileEntry(event);
    expect(entry?.label).toBe("file");
    expect(entry?.openPath).toBeNull();
  });

  it("returns null for event without summary", () => {
    const event = makeEvent({ type: "tool.finished", payload: {} });
    expect(extractReadFileEntry(event)).toBeNull();
  });
});

describe("normalizeSearchSummary", () => {
  it("returns 'Searched' for empty string", () => {
    expect(normalizeSearchSummary("")).toBe("Searched");
    expect(normalizeSearchSummary("  ")).toBe("Searched");
  });

  it("passes through 'searched for' prefix", () => {
    expect(normalizeSearchSummary("Searched for pattern")).toBe("Searched for pattern");
  });

  it("returns 'Searched' for 'Completed Glob'", () => {
    expect(normalizeSearchSummary("Completed Glob")).toBe("Searched");
  });

  it("returns 'Searched' for 'Completed Grep'", () => {
    expect(normalizeSearchSummary("Completed Grep")).toBe("Searched");
  });

  it("prepends 'Searched for' to other summaries", () => {
    expect(normalizeSearchSummary("*.ts files")).toBe("Searched for *.ts files");
  });
});

describe("searchContextFromEvent", () => {
  it("extracts toolName and searchParams", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "Glob", searchParams: "*.ts" } });
    const ctx = searchContextFromEvent(event);
    expect(ctx.toolName).toBe("Glob");
    expect(ctx.searchParams).toBe("*.ts");
  });

  it("returns nulls for missing fields", () => {
    const event = makeEvent({ type: "tool.finished", payload: {} });
    const ctx = searchContextFromEvent(event);
    expect(ctx.toolName).toBeNull();
    expect(ctx.searchParams).toBeNull();
  });
});

describe("buildSearchRunningLabel", () => {
  it("builds label with tool name", () => {
    expect(buildSearchRunningLabel("Glob", null)).toBe("Searching Glob");
  });

  it("includes search params", () => {
    expect(buildSearchRunningLabel("Grep", "pattern")).toBe("Searching Grep (pattern)");
  });

  it("uses Search as fallback tool name", () => {
    expect(buildSearchRunningLabel(null, null)).toBe("Searching Search");
    expect(buildSearchRunningLabel("", null)).toBe("Searching Search");
  });

  it("shortens absolute paths in search params", () => {
    expect(buildSearchRunningLabel("Glob", "path=/home/user/project/src")).toContain("path=src");
  });
});

describe("buildSearchCompletedFallbackLabel", () => {
  it("builds label with tool name", () => {
    expect(buildSearchCompletedFallbackLabel("Glob", null)).toBe("Searched Glob");
  });

  it("includes search params", () => {
    expect(buildSearchCompletedFallbackLabel("Grep", "pattern")).toBe("Searched Grep (pattern)");
  });

  it("omits tool name when empty", () => {
    expect(buildSearchCompletedFallbackLabel(null, null)).toBe("Searched");
  });
});

describe("extractSearchEntryLabel", () => {
  it("uses summary when available", () => {
    const event = makeEvent({ type: "tool.finished", payload: { summary: "Found 5 files" } });
    expect(extractSearchEntryLabel(event)).toBe("Searched for Found 5 files");
  });

  it("normalizes 'Completed Glob' to fallback label", () => {
    const event = makeEvent({ type: "tool.finished", payload: { summary: "Completed Glob" } });
    expect(extractSearchEntryLabel(event, { toolName: "Glob" })).toBe("Searched Glob");
  });

  it("uses fallback when no summary", () => {
    const event = makeEvent({ type: "tool.finished", payload: {} });
    expect(extractSearchEntryLabel(event, { toolName: "Grep", searchParams: "*.ts" })).toBe("Searched Grep (*.ts)");
  });
});

describe("extractExploreRunKind", () => {
  it("returns read for Read tool events", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "Read" } });
    expect(extractExploreRunKind(event)).toBe("read");
  });

  it("returns search for Glob tool events", () => {
    const event = makeEvent({ type: "tool.finished", payload: { toolName: "Glob" } });
    expect(extractExploreRunKind(event)).toBe("search");
  });

  it("returns search for explore-like bash commands", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "bash", isBash: true, command: "ls -la" } });
    expect(extractExploreRunKind(event)).toBe("search");
  });

  it("returns search for pure explore bash chains", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "bash", isBash: true, command: "ls && find . -name '*.ts'" } });
    expect(extractExploreRunKind(event)).toBe("search");
  });

  it("returns null for mixed bash chains", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "bash", isBash: true, command: "ls && git status" } });
    expect(extractExploreRunKind(event)).toBeNull();
  });

  it("returns null for non-explore events", () => {
    const event = makeEvent({ type: "tool.started", payload: { toolName: "edit" } });
    expect(extractExploreRunKind(event)).toBeNull();
  });
});

describe("extractExploreActivityGroups", () => {
  it("returns empty for empty events", () => {
    expect(extractExploreActivityGroups([])).toEqual([]);
  });

  it("groups consecutive read operations", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["t1"] } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "Read", toolUseId: "t2" } }),
      makeEvent({ id: "e4", type: "tool.finished", idx: 4, payload: { toolName: "Read", summary: "Read /src/b.ts", precedingToolUseIds: ["t2"] } }),
    ];
    const groups = extractExploreActivityGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].fileCount).toBe(2);
  });

  it("flushes group on message.delta", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Read", summary: "Read a.ts", precedingToolUseIds: ["t1"] } }),
      makeEvent({ id: "e3", type: "message.delta", idx: 3, payload: { role: "assistant" } }),
      makeEvent({ id: "e4", type: "tool.started", idx: 4, payload: { toolName: "Glob", toolUseId: "t2" } }),
      makeEvent({ id: "e5", type: "tool.finished", idx: 5, payload: { toolName: "Glob", summary: "Found files", precedingToolUseIds: ["t2"] } }),
    ];
    const groups = extractExploreActivityGroups(events);
    expect(groups.length).toBe(2);
  });

  it("splits groups on thinking.delta without message.delta", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["t1"] } }),
      makeEvent({ id: "e3", type: "thinking.delta", idx: 3, payload: { messageId: "m2", delta: "next" } }),
      makeEvent({ id: "e4", type: "tool.started", idx: 4, payload: { toolName: "Read", toolUseId: "t2" } }),
      makeEvent({ id: "e5", type: "tool.finished", idx: 5, payload: { toolName: "Read", summary: "Read /src/b.ts", precedingToolUseIds: ["t2"] } }),
    ];

    const groups = extractExploreActivityGroups(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].fileCount).toBe(1);
    expect(groups[1].fileCount).toBe(1);
  });

  it("does not flush on boundary when run is pending", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "thinking.delta", idx: 2, payload: { messageId: "m2", delta: "wait" } }),
      makeEvent({ id: "e3", type: "tool.finished", idx: 3, payload: { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["t1"] } }),
    ];

    const groups = extractExploreActivityGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].startIdx).toBe(1);
    expect(groups[0].endIdx).toBe(3);
  });

  it("splits groups on plan and subagent boundaries when idle", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["t1"] } }),
      makeEvent({ id: "e3", type: "plan.created", idx: 3, payload: { messageId: "m2", content: "# Plan", filePath: ".claude/plan.md" } }),
      makeEvent({ id: "e4", type: "tool.started", idx: 4, payload: { toolName: "Glob", toolUseId: "t2" } }),
      makeEvent({ id: "e5", type: "tool.finished", idx: 5, payload: { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["t2"] } }),
      makeEvent({ id: "e6", type: "subagent.started", idx: 6, payload: { toolUseId: "sa-1", agentId: "a1", agentType: "Explore", description: "scan" } }),
      makeEvent({ id: "e7", type: "tool.started", idx: 7, payload: { toolName: "Read", toolUseId: "t3" } }),
      makeEvent({ id: "e8", type: "tool.finished", idx: 8, payload: { toolName: "Read", summary: "Read /src/b.ts", precedingToolUseIds: ["t3"] } }),
    ];

    const groups = extractExploreActivityGroups(events);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.startIdx)).toEqual([1, 4, 7]);
  });

  it("uses distinct ids for distinct spans", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Read", summary: "Read /src/a.ts", precedingToolUseIds: ["t1"] } }),
      makeEvent({ id: "e3", type: "thinking.delta", idx: 3, payload: { messageId: "m2", delta: "next" } }),
      makeEvent({ id: "e4", type: "tool.started", idx: 4, payload: { toolName: "Read", toolUseId: "t2" } }),
      makeEvent({ id: "e5", type: "tool.finished", idx: 6, payload: { toolName: "Read", summary: "Read /src/b.ts", precedingToolUseIds: ["t2"] } }),
    ];

    const groups = extractExploreActivityGroups(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].id).toBe("explore:1:2");
    expect(groups[1].id).toBe("explore:4:6");
    expect(groups[0].id).not.toBe(groups[1].id);
  });

  it("counts search and file entries separately", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Glob", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Glob", summary: "Found files", precedingToolUseIds: ["t1"] } }),
      makeEvent({ id: "e3", type: "tool.started", idx: 3, payload: { toolName: "Read", toolUseId: "t2" } }),
      makeEvent({ id: "e4", type: "tool.finished", idx: 4, payload: { toolName: "Read", summary: "Read /a.ts", precedingToolUseIds: ["t2"] } }),
    ];
    const groups = extractExploreActivityGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].fileCount).toBe(1);
    expect(groups[0].searchCount).toBe(1);
  });

  it("marks group as running while pending", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
    ];
    const groups = extractExploreActivityGroups(events);
    expect(groups.length).toBe(1);
    expect(groups[0].status).toBe("running");
  });

  it("marks group as success when all finished", () => {
    const events = [
      makeEvent({ id: "e1", type: "tool.started", idx: 1, payload: { toolName: "Read", toolUseId: "t1" } }),
      makeEvent({ id: "e2", type: "tool.finished", idx: 2, payload: { toolName: "Read", summary: "Read a.ts", precedingToolUseIds: ["t1"] } }),
    ];
    const groups = extractExploreActivityGroups(events);
    expect(groups[0].status).toBe("success");
  });
});
