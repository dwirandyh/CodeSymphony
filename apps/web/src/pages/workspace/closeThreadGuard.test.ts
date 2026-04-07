import { describe, expect, it } from "vitest";
import type { ChatThread } from "@codesymphony/shared-types";
import { shouldConfirmCloseThread } from "./closeThreadGuard";

function createThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    worktreeId: "worktree-1",
    title: "Thread 1",
    kind: "default",
    permissionProfile: "default",
    permissionMode: "default",
    mode: "default",
    titleEditedManually: false,
    claudeSessionId: null,
    active: false,
    createdAt: "2026-02-25T00:00:00.000Z",
    updatedAt: "2026-02-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("shouldConfirmCloseThread", () => {
  it("returns true for selected thread when AI is active", () => {
    const thread = createThread();

    const result = shouldConfirmCloseThread({
      threadId: thread.id,
      selectedThreadId: thread.id,
      showStopAction: true,
      waitingAssistantThreadId: null,
      threads: [thread],
    });

    expect(result).toBe(true);
  });

  it("returns true for selected thread when waiting assistant points to thread", () => {
    const thread = createThread();

    const result = shouldConfirmCloseThread({
      threadId: thread.id,
      selectedThreadId: thread.id,
      showStopAction: false,
      waitingAssistantThreadId: thread.id,
      threads: [thread],
    });

    expect(result).toBe(true);
  });

  it("returns false for selected thread when AI is idle", () => {
    const thread = createThread();

    const result = shouldConfirmCloseThread({
      threadId: thread.id,
      selectedThreadId: thread.id,
      showStopAction: false,
      waitingAssistantThreadId: null,
      threads: [thread],
    });

    expect(result).toBe(false);
  });

  it("returns true for selected thread when thread.active is still true", () => {
    const thread = createThread({ active: true });

    const result = shouldConfirmCloseThread({
      threadId: thread.id,
      selectedThreadId: thread.id,
      showStopAction: false,
      waitingAssistantThreadId: null,
      threads: [thread],
    });

    expect(result).toBe(true);
  });

  it("returns true for non-selected thread when thread.active is true", () => {
    const selectedThread = createThread({ id: "thread-1" });
    const targetThread = createThread({ id: "thread-2", active: true });

    const result = shouldConfirmCloseThread({
      threadId: targetThread.id,
      selectedThreadId: selectedThread.id,
      showStopAction: false,
      waitingAssistantThreadId: null,
      threads: [selectedThread, targetThread],
    });

    expect(result).toBe(true);
  });

  it("returns false for non-selected thread when thread is idle", () => {
    const selectedThread = createThread({ id: "thread-1" });
    const targetThread = createThread({ id: "thread-2", active: false });

    const result = shouldConfirmCloseThread({
      threadId: targetThread.id,
      selectedThreadId: selectedThread.id,
      showStopAction: false,
      waitingAssistantThreadId: null,
      threads: [selectedThread, targetThread],
    });

    expect(result).toBe(false);
  });
});
