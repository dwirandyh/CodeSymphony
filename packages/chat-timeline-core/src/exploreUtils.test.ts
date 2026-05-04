import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { extractExploreActivityGroups, extractReadFileEntry, normalizeSearchSummary } from "./exploreUtils.js";

function makeEvent(
  idx: number,
  type: ChatEvent["type"],
  payload: Record<string, unknown>,
): ChatEvent {
  return {
    id: `evt-${idx}`,
    threadId: "thread-1",
    idx,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("bash-backed explore activity", () => {
  it("normalizes existing 'Search for' summaries without duplicating the phrase", () => {
    expect(normalizeSearchSummary('Search for "last updated" in README.md')).toBe('Searched for "last updated" in README.md');
  });

  it("extracts a readable target from rtk sed summaries", () => {
    const event = makeEvent(1, "tool.finished", {
      toolName: "Bash",
      command: "rtk sed -n 720,860p course_main_page.dart",
      summary: "Ran rtk sed -n 720,860p course_main_page.dart",
      precedingToolUseIds: ["bash-1"],
    });

    expect(extractReadFileEntry(event)).toEqual({
      label: "course_main_page.dart",
      openPath: "course_main_page.dart",
    });
  });

  it("extracts a readable target from shell-wrapped rtk sed summaries", () => {
    const event = makeEvent(1, "tool.finished", {
      toolName: "Bash",
      command: '/bin/zsh -lc "rtk sed -n 1,260p packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart"',
      summary: 'Ran /bin/zsh -lc "rtk sed -n 1,260p packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart"',
      precedingToolUseIds: ["bash-1"],
    });

    expect(extractReadFileEntry(event)).toEqual({
      label: "node_training_flow_bloc.dart",
      openPath: "packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart",
    });
  });

  it("extracts a readable target from shell-wrapped nl | sed summaries", () => {
    const event = makeEvent(1, "tool.finished", {
      toolName: "Bash",
      command: '/bin/zsh -lc "rtk nl -ba packages/course/lib/presentation/course_main_page/view/course_main_page.dart | sed -n \'1,220p\'"',
      summary: 'Ran /bin/zsh -lc "rtk nl -ba packages/course/lib/presentation/course_main_page/view/course_main_page.dart | sed -n \'1,220p\'"',
      precedingToolUseIds: ["bash-1"],
    });

    expect(extractReadFileEntry(event)).toEqual({
      label: "course_main_page.dart",
      openPath: "packages/course/lib/presentation/course_main_page/view/course_main_page.dart",
    });
  });

  it("groups rtk sed inspection as a read explore activity", () => {
    const groups = extractExploreActivityGroups([
      makeEvent(1, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-1",
        command: "rtk sed -n 720,860p course_main_page.dart",
      }),
      makeEvent(2, "tool.finished", {
        toolName: "Bash",
        command: "rtk sed -n 720,860p course_main_page.dart",
        summary: "Ran rtk sed -n 720,860p course_main_page.dart",
        precedingToolUseIds: ["bash-1"],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      fileCount: 1,
      searchCount: 0,
      status: "success",
    });
    expect(groups[0]?.entries[0]).toMatchObject({
      kind: "read",
      label: "course_main_page.dart",
      openPath: "course_main_page.dart",
      pending: false,
    });
  });

  it("groups rtk rg inspection as a search explore activity", () => {
    const groups = extractExploreActivityGroups([
      makeEvent(1, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-2",
        command: "rtk rg -n course_main_page.dart lib -S",
      }),
      makeEvent(2, "tool.finished", {
        toolName: "Bash",
        command: "rtk rg -n course_main_page.dart lib -S",
        summary: "Ran rtk rg -n course_main_page.dart lib -S",
        precedingToolUseIds: ["bash-2"],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      fileCount: 0,
      searchCount: 1,
      status: "success",
    });
    expect(groups[0]?.entries[0]?.kind).toBe("search");
  });

  it("groups shell-wrapped rg and rtk sed commands as explore activity", () => {
    const groups = extractExploreActivityGroups([
      makeEvent(1, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-1",
        command: "/bin/zsh -lc 'rg --files packages/course/lib/presentation/course_main_page'",
      }),
      makeEvent(2, "tool.finished", {
        toolName: "Bash",
        command: "/bin/zsh -lc 'rg --files packages/course/lib/presentation/course_main_page'",
        summary: "Ran /bin/zsh -lc 'rg --files packages/course/lib/presentation/course_main_page'",
        precedingToolUseIds: ["bash-1"],
      }),
      makeEvent(3, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-2",
        command: '/bin/zsh -lc "rtk sed -n 1,260p packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart"',
      }),
      makeEvent(4, "tool.finished", {
        toolName: "Bash",
        command: '/bin/zsh -lc "rtk sed -n 1,260p packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart"',
        summary: 'Ran /bin/zsh -lc "rtk sed -n 1,260p packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart"',
        precedingToolUseIds: ["bash-2"],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      fileCount: 1,
      searchCount: 1,
      status: "success",
    });
    expect(groups[0]?.entries).toEqual([
      expect.objectContaining({ kind: "search", label: "Searched" }),
      expect.objectContaining({
        kind: "read",
        label: "node_training_flow_bloc.dart",
        openPath: "packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart",
      }),
    ]);
  });

  it("groups shell-wrapped nl | sed inspection as a read explore activity", () => {
    const groups = extractExploreActivityGroups([
      makeEvent(1, "tool.started", {
        toolName: "Bash",
        toolUseId: "bash-1",
        command: '/bin/zsh -lc "rtk nl -ba packages/course/lib/presentation/course_main_page/view/course_main_page.dart | sed -n \'1,220p\'"',
      }),
      makeEvent(2, "tool.finished", {
        toolName: "Bash",
        command: '/bin/zsh -lc "rtk nl -ba packages/course/lib/presentation/course_main_page/view/course_main_page.dart | sed -n \'1,220p\'"',
        summary: 'Ran /bin/zsh -lc "rtk nl -ba packages/course/lib/presentation/course_main_page/view/course_main_page.dart | sed -n \'1,220p\'"',
        precedingToolUseIds: ["bash-1"],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      fileCount: 1,
      searchCount: 0,
      status: "success",
    });
    expect(groups[0]?.entries[0]).toMatchObject({
      kind: "read",
      label: "course_main_page.dart",
      openPath: "packages/course/lib/presentation/course_main_page/view/course_main_page.dart",
      pending: false,
    });
  });

  it("uses a failed-search label for failed shell-wrapped bash search summaries", () => {
    const event = makeEvent(1, "tool.finished", {
      toolName: "Bash",
      command: `/bin/zsh -lc "rtk rg -n \\"NodeTrainingFlowPage\\\\.route\\\\(|NodeTrainingFlowPage\\\\(\\" packages/course/lib -g '*.dart'"`,
      summary: `Command failed: /bin/zsh -lc "rtk rg -n \\"NodeTrainingFlowPage\\\\.route\\\\(|NodeTrainingFlowPage\\\\(\\" packages/course/lib -g '*.dart'"`,
      precedingToolUseIds: ["bash-3"],
    });

    const groups = extractExploreActivityGroups([event]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries[0]).toMatchObject({
      kind: "search",
      label: "Failed search",
    });
  });
});
