import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import {
  isExploreLikeBashCommand,
  isExploreLikeBashEvent,
  isReadLikeBashEvent,
} from "./eventUtils.js";

function makeBashEvent(command: string): ChatEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    idx: 1,
    type: "tool.started",
    payload: {
      toolName: "Bash",
      toolUseId: "bash-1",
      command,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("explore-like bash classification", () => {
  it("treats rtk-wrapped rg commands as explore activity", () => {
    expect(isExploreLikeBashCommand("rtk rg -n course_main_page.dart lib -S")).toBe(true);
    expect(isExploreLikeBashEvent(makeBashEvent("rtk rg -n course_main_page.dart lib -S"))).toBe(true);
  });

  it("treats read-only rtk sed commands as explore activity", () => {
    const event = makeBashEvent("rtk sed -n 720,860p course_main_page.dart");
    expect(isExploreLikeBashCommand("rtk sed -n 720,860p course_main_page.dart")).toBe(true);
    expect(isExploreLikeBashEvent(event)).toBe(true);
    expect(isReadLikeBashEvent(event)).toBe(true);
  });

  it("treats shell-wrapped rtk sed commands as explore activity", () => {
    const command = '/bin/zsh -lc "rtk sed -n 1,260p packages/course/lib/presentation/course_main_page/bloc/node_training_flow_bloc.dart"';
    const event = makeBashEvent(command);
    expect(isExploreLikeBashCommand(command)).toBe(true);
    expect(isExploreLikeBashEvent(event)).toBe(true);
    expect(isReadLikeBashEvent(event)).toBe(true);
  });

  it("treats shell-wrapped rg commands as explore activity", () => {
    const command = "/bin/zsh -lc 'rg --files packages/course/lib/presentation/course_main_page'";
    expect(isExploreLikeBashCommand(command)).toBe(true);
    expect(isExploreLikeBashEvent(makeBashEvent(command))).toBe(true);
  });

  it("treats shell-wrapped nl | sed inspection commands as read explore activity", () => {
    const command = '/bin/zsh -lc "rtk nl -ba packages/course/lib/presentation/course_main_page/view/course_main_page.dart | sed -n \'1,220p\'"';
    const event = makeBashEvent(command);
    expect(isExploreLikeBashCommand(command)).toBe(true);
    expect(isExploreLikeBashEvent(event)).toBe(true);
    expect(isReadLikeBashEvent(event)).toBe(true);
  });

  it("keeps in-place sed commands out of explore activity", () => {
    const command = "rtk sed -i '' 's/foo/bar/' course_main_page.dart";
    expect(isExploreLikeBashCommand(command)).toBe(false);
    expect(isReadLikeBashEvent(makeBashEvent(command))).toBe(false);
  });

  it("keeps direct rtk ls commands as regular tool runs", () => {
    expect(isExploreLikeBashCommand("rtk ls -la")).toBe(false);
  });
});
