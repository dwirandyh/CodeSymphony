import { describe, it, expect } from "vitest";
import { queryKeys } from "./queryKeys";

describe("queryKeys", () => {
  it("repositories.all returns array", () => {
    expect(queryKeys.repositories.all).toEqual(["repositories"]);
  });

  it("worktrees.gitStatus returns key with worktreeId", () => {
    expect(queryKeys.worktrees.gitStatus("w1")).toEqual(["worktrees", "w1", "gitStatus"]);
  });

  it("worktrees.gitDiff includes filePath", () => {
    expect(queryKeys.worktrees.gitDiff("w1", "file.ts")).toEqual(["worktrees", "w1", "gitDiff", "file.ts"]);
  });

  it("worktrees.gitDiff uses __all__ when no filePath", () => {
    expect(queryKeys.worktrees.gitDiff("w1")).toEqual(["worktrees", "w1", "gitDiff", "__all__"]);
  });

  it("worktrees.fileIndex returns key", () => {
    expect(queryKeys.worktrees.fileIndex("w1")).toEqual(["worktrees", "w1", "fileIndex"]);
  });

  it("worktrees.fileContents includes path", () => {
    expect(queryKeys.worktrees.fileContents("w1", "a.ts")).toEqual(["worktrees", "w1", "fileContents", "a.ts"]);
  });

  it("threads.list includes worktreeId", () => {
    expect(queryKeys.threads.list("w1")).toEqual(["threads", "list", "w1"]);
  });

  it("threads.timelineSnapshot includes threadId", () => {
    expect(queryKeys.threads.timelineSnapshot("t1")).toEqual(["threads", "t1", "timelineSnapshot"]);
  });

  it("threads.statusSnapshot includes threadId", () => {
    expect(queryKeys.threads.statusSnapshot("t1")).toEqual(["threads", "t1", "statusSnapshot"]);
  });

  it("threads.messages includes threadId", () => {
    expect(queryKeys.threads.messages("t1")).toEqual(["threads", "t1", "messages"]);
  });

  it("threads.events includes threadId", () => {
    expect(queryKeys.threads.events("t1")).toEqual(["threads", "t1", "events"]);
  });

  it("filesystem.browse with path", () => {
    expect(queryKeys.filesystem.browse("/home")).toEqual(["filesystem", "browse", "/home"]);
  });

  it("filesystem.browse without path uses __root__", () => {
    expect(queryKeys.filesystem.browse()).toEqual(["filesystem", "browse", "__root__"]);
  });

  it("system.installedApps is correct", () => {
    expect(queryKeys.system.installedApps).toEqual(["system", "installedApps"]);
  });
});
