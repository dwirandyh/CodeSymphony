import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCreateRepository } from "./useCreateRepository";
import { useCreateWorktree } from "./useCreateWorktree";
import { useDeleteWorktree } from "./useDeleteWorktree";
import { useDeleteRepository } from "./useDeleteRepository";
import { useCreateThread } from "./useCreateThread";
import { useDeleteThread } from "./useDeleteThread";
import { useSendMessage } from "./useSendMessage";
import { useResolvePermission } from "./useResolvePermission";
import { useAnswerQuestion } from "./useAnswerQuestion";
import { useDismissQuestion } from "./useDismissQuestion";
import { useApprovePlan } from "./useApprovePlan";
import { useRevisePlan } from "./useRevisePlan";
import { useStopRun } from "./useStopRun";
import { useGitCommit } from "./useGitCommit";
import { useDiscardGitChange } from "./useDiscardGitChange";
import { useRenameWorktreeBranch } from "./useRenameWorktreeBranch";

vi.mock("../../lib/api", () => ({
  api: {
    createRepository: vi.fn().mockResolvedValue({ id: "r1", name: "repo" }),
    createWorktree: vi.fn().mockResolvedValue({ worktree: { id: "w1", branch: "main" } }),
    deleteWorktree: vi.fn().mockResolvedValue(undefined),
    deleteRepository: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue({ id: "t1", title: "Thread" }),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ id: "m1" }),
    resolvePermission: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    dismissQuestion: vi.fn().mockResolvedValue(undefined),
    approvePlan: vi.fn().mockResolvedValue(undefined),
    revisePlan: vi.fn().mockResolvedValue(undefined),
    stopRun: vi.fn().mockResolvedValue(undefined),
    gitCommit: vi.fn().mockResolvedValue(undefined),
    discardGitChange: vi.fn().mockResolvedValue(undefined),
    renameWorktreeBranch: vi.fn().mockResolvedValue({ id: "w1", branch: "new-name" }),
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function HookWrapper({ hook, hookArgs = [] }: { hook: (...args: unknown[]) => unknown; hookArgs?: unknown[] }) {
  const result = hook(...hookArgs);
  return <div data-testid="result">{typeof result === "object" && result !== null ? "ok" : "null"}</div>;
}

function renderHook(hook: (...args: unknown[]) => unknown, hookArgs: unknown[] = []) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <HookWrapper hook={hook} hookArgs={hookArgs} />
      </QueryClientProvider>
    );
  });
}

describe("mutation hooks", () => {
  it("useCreateRepository renders", () => {
    renderHook(useCreateRepository);
    expect(container.textContent).toBe("ok");
  });

  it("useCreateWorktree renders", () => {
    renderHook(useCreateWorktree);
    expect(container.textContent).toBe("ok");
  });

  it("useDeleteWorktree renders", () => {
    renderHook(useDeleteWorktree);
    expect(container.textContent).toBe("ok");
  });

  it("useDeleteRepository renders", () => {
    renderHook(useDeleteRepository);
    expect(container.textContent).toBe("ok");
  });

  it("useCreateThread renders", () => {
    renderHook(useCreateThread);
    expect(container.textContent).toBe("ok");
  });

  it("useDeleteThread renders", () => {
    renderHook(useDeleteThread as (...args: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useSendMessage renders", () => {
    renderHook(useSendMessage);
    expect(container.textContent).toBe("ok");
  });

  it("useResolvePermission renders", () => {
    renderHook(useResolvePermission);
    expect(container.textContent).toBe("ok");
  });

  it("useAnswerQuestion renders", () => {
    renderHook(useAnswerQuestion);
    expect(container.textContent).toBe("ok");
  });

  it("useDismissQuestion renders", () => {
    renderHook(useDismissQuestion);
    expect(container.textContent).toBe("ok");
  });

  it("useApprovePlan renders", () => {
    renderHook(useApprovePlan);
    expect(container.textContent).toBe("ok");
  });

  it("useRevisePlan renders", () => {
    renderHook(useRevisePlan);
    expect(container.textContent).toBe("ok");
  });

  it("useStopRun renders", () => {
    renderHook(useStopRun);
    expect(container.textContent).toBe("ok");
  });

  it("useGitCommit renders", () => {
    renderHook(useGitCommit as (...args: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useDiscardGitChange renders", () => {
    renderHook(useDiscardGitChange as (...args: unknown[]) => unknown, ["wt-1"]);
    expect(container.textContent).toBe("ok");
  });

  it("useRenameWorktreeBranch renders", () => {
    renderHook(useRenameWorktreeBranch);
    expect(container.textContent).toBe("ok");
  });
});
