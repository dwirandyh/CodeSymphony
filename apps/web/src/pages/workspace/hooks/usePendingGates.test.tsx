import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { usePendingGates, type PendingGatesDeps } from "./usePendingGates";

const {
  mockResolvePermission,
  mockAnswerQuestion,
  mockApprovePlan,
  mockRevisePlan,
  mockDismissQuestion,
} = vi.hoisted(() => ({
  mockResolvePermission: vi.fn().mockResolvedValue(undefined),
  mockAnswerQuestion: vi.fn().mockResolvedValue(undefined),
  mockApprovePlan: vi.fn().mockResolvedValue(undefined),
  mockRevisePlan: vi.fn().mockResolvedValue(undefined),
  mockDismissQuestion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/api", () => ({
  api: {
    resolvePermission: mockResolvePermission,
    answerQuestion: mockAnswerQuestion,
    approvePlan: mockApprovePlan,
    revisePlan: mockRevisePlan,
    dismissQuestion: mockDismissQuestion,
  },
}));


let container: HTMLDivElement;
let root: Root;
let hookResult: ReturnType<typeof usePendingGates>;

let mockDeps: PendingGatesDeps;

function makeEvent(idx: number, type: ChatEvent["type"], payload: Record<string, unknown> = {}): ChatEvent {
  return {
    id: `e-${idx}`,
    threadId: "t1",
    idx,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function TestComponent({
  events,
  selectedThreadId,
}: {
  events: ChatEvent[];
  selectedThreadId: string | null;
}) {
  hookResult = usePendingGates(events, selectedThreadId, mockDeps);
  return (
    <div>
      perms:{hookResult.pendingPermissionRequests.length}
      ,questions:{hookResult.pendingQuestionRequests.length}
      ,plan:{hookResult.pendingPlan ? "yes" : "no"}
      ,showPlan:{String(hookResult.showPlanDecisionComposer)}
      ,waitingGate:{String(hookResult.isWaitingForUserGate)}
    </div>
  );
}

let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockDeps = {
    onError: vi.fn(),
    startWaitingAssistant: vi.fn(),
    clearWaitingAssistantForThread: vi.fn(),
  };
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(events: ChatEvent[], threadId: string | null = "t1") {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TestComponent events={events} selectedThreadId={threadId} />
      </QueryClientProvider>
    );
  });
}

describe("usePendingGates", () => {
  it("returns no pending items when events are empty", () => {
    render([]);
    expect(hookResult.pendingPermissionRequests).toHaveLength(0);
    expect(hookResult.pendingQuestionRequests).toHaveLength(0);
    expect(hookResult.pendingPlan).toBeNull();
    expect(hookResult.isWaitingForUserGate).toBe(false);
  });

  it("detects a pending permission request", () => {
    const events = [
      makeEvent(0, "permission.requested", {
        requestId: "req-1",
        toolName: "Bash",
        command: "rm -rf /",
      }),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests).toHaveLength(1);
    expect(hookResult.pendingPermissionRequests[0].requestId).toBe("req-1");
    expect(hookResult.pendingPermissionRequests[0].toolName).toBe("Bash");
    expect(hookResult.pendingPermissionRequests[0].command).toBe("rm -rf /");
    expect(hookResult.hasPendingPermissionRequests).toBe(true);
    expect(hookResult.isWaitingForUserGate).toBe(true);
  });

  it("clears permission request after resolution", () => {
    const events = [
      makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" }),
      makeEvent(1, "permission.resolved", { requestId: "req-1" }),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests).toHaveLength(0);
    expect(hookResult.hasPendingPermissionRequests).toBe(false);
  });

  it("detects a pending question request", () => {
    const events = [
      makeEvent(0, "question.requested", {
        requestId: "q-1",
        questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }],
      }),
    ];
    render(events);
    expect(hookResult.pendingQuestionRequests).toHaveLength(1);
    expect(hookResult.pendingQuestionRequests[0].questions[0].question).toBe("Which approach?");
    expect(hookResult.hasPendingQuestionRequests).toBe(true);
  });

  it("clears question after answered", () => {
    const events = [
      makeEvent(0, "question.requested", { requestId: "q-1", questions: [{ question: "Q?" }] }),
      makeEvent(1, "question.answered", { requestId: "q-1" }),
    ];
    render(events);
    expect(hookResult.pendingQuestionRequests).toHaveLength(0);
  });

  it("clears question after dismissed", () => {
    const events = [
      makeEvent(0, "question.requested", { requestId: "q-1", questions: [{ question: "Q?" }] }),
      makeEvent(1, "question.dismissed", { requestId: "q-1" }),
    ];
    render(events);
    expect(hookResult.pendingQuestionRequests).toHaveLength(0);
  });

  it("clears all pending on chat.completed", () => {
    const events = [
      makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" }),
      makeEvent(1, "question.requested", { requestId: "q-1", questions: [{ question: "Q?" }] }),
      makeEvent(2, "chat.completed", {}),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests).toHaveLength(0);
    expect(hookResult.pendingQuestionRequests).toHaveLength(0);
  });

  it("clears all pending on chat.failed", () => {
    const events = [
      makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" }),
      makeEvent(1, "chat.failed", {}),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests).toHaveLength(0);
  });

  it("detects a pending plan", () => {
    const events = [
      makeEvent(0, "plan.created", { content: "My plan content", filePath: ".claude/plans/plan.md" }),
      makeEvent(1, "chat.completed", {}),
    ];
    render(events);
    expect(hookResult.pendingPlan).not.toBeNull();
    expect(hookResult.pendingPlan?.content).toBe("My plan content");
    expect(hookResult.pendingPlan?.status).toBe("pending");
  });

  it("marks plan as approved after plan.approved event", () => {
    const events = [
      makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
      makeEvent(1, "plan.approved", {}),
    ];
    render(events);
    expect(hookResult.pendingPlan?.status).toBe("approved");
  });

  it("marks plan as sending after plan.revision_requested", () => {
    const events = [
      makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
      makeEvent(1, "plan.revision_requested", {}),
    ];
    render(events);
    expect(hookResult.pendingPlan?.status).toBe("sending");
  });

  it("detects edit tool permission with editTarget", () => {
    const events = [
      makeEvent(0, "permission.requested", {
        requestId: "req-1",
        toolName: "Edit",
        toolInput: { file_path: "/src/foo.ts" },
      }),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests[0].editTarget).toBeTruthy();
  });

  it("ignores permission.requested with empty requestId", () => {
    const events = [
      makeEvent(0, "permission.requested", { requestId: "", toolName: "Bash" }),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests).toHaveLength(0);
  });

  it("does not show plan decision before ExitPlanMode completes", () => {
    const events = [
      makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
    ];
    render(events);
    expect(hookResult.showPlanDecisionComposer).toBe(false);
  });

  it("shows plan decision after ExitPlanMode completes", () => {
    const events = [
      makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
      makeEvent(1, "tool.started", { toolName: "ExitPlanMode", toolUseId: "exit-1" }),
      makeEvent(2, "tool.finished", { precedingToolUseIds: ["exit-1"] }),
    ];
    render(events);
    expect(hookResult.showPlanDecisionComposer).toBe(true);
  });

  it("falls back to chat.completed when older histories do not include ExitPlanMode", () => {
    const events = [
      makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
      makeEvent(1, "chat.completed", {}),
    ];
    render(events);
    expect(hookResult.showPlanDecisionComposer).toBe(true);
  });

  it("skips plan.created with empty content", () => {
    const events = [
      makeEvent(0, "plan.created", { content: "", filePath: ".claude/plans/plan.md" }),
    ];
    render(events);
    expect(hookResult.pendingPlan).toBeNull();
  });

  it("extracts blockedPath and decisionReason from permission request", () => {
    const events = [
      makeEvent(0, "permission.requested", {
        requestId: "req-1",
        toolName: "Write",
        toolInput: { path: "/etc/passwd" },
        blockedPath: "/etc/passwd",
        decisionReason: "Security risk",
      }),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests[0].blockedPath).toBe("/etc/passwd");
    expect(hookResult.pendingPermissionRequests[0].decisionReason).toBe("Security risk");
    expect(hookResult.pendingPermissionRequests[0].editTarget).toBeTruthy();
  });

  it("handles question with multiSelect and header", () => {
    const events = [
      makeEvent(0, "question.requested", {
        requestId: "q-1",
        questions: [{
          question: "Select options",
          header: "Configuration",
          options: [{ label: "A", description: "Option A" }],
          multiSelect: true,
        }],
      }),
    ];
    render(events);
    const q = hookResult.pendingQuestionRequests[0].questions[0];
    expect(q.header).toBe("Configuration");
    expect(q.multiSelect).toBe(true);
    expect(q.options?.[0].description).toBe("Option A");
  });

  it("handles non-record toolInput gracefully", () => {
    const events = [
      makeEvent(0, "permission.requested", {
        requestId: "req-1",
        toolName: "Edit",
        toolInput: "invalid",
      }),
    ];
    render(events);
    expect(hookResult.pendingPermissionRequests[0].editTarget).toBeNull();
  });

  describe("resolvePermission", () => {
    it("calls mutation with allow decision", async () => {
      const events = [
        makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" }),
      ];
      render(events);

      await act(async () => {
        await hookResult.resolvePermission("req-1", "allow");
      });

      expect(mockResolvePermission).toHaveBeenCalledWith("t1", {
        requestId: "req-1",
        decision: "allow",
      });
      expect(mockDeps.startWaitingAssistant).toHaveBeenCalledWith("t1");
    });

    it("does not start waiting assistant on deny", async () => {
      render([makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" })]);

      await act(async () => {
        await hookResult.resolvePermission("req-1", "deny");
      });

      expect(mockDeps.startWaitingAssistant).not.toHaveBeenCalled();
      expect(mockResolvePermission).toHaveBeenCalled();
    });

    it("does nothing when no thread is selected", async () => {
      render([], null);
      await act(async () => {
        await hookResult.resolvePermission("req-1", "allow");
      });
      expect(mockResolvePermission).not.toHaveBeenCalled();
    });

    it("handles errors and clears waiting assistant", async () => {
      mockResolvePermission.mockRejectedValueOnce(new Error("Network error"));
      render([makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" })]);

      await act(async () => {
        await hookResult.resolvePermission("req-1", "allow");
      });

      expect(mockDeps.clearWaitingAssistantForThread).toHaveBeenCalledWith("t1");
      expect(mockDeps.onError).toHaveBeenCalledWith("Network error");
    });

    it("does not clear waiting assistant on deny error", async () => {
      mockResolvePermission.mockRejectedValueOnce(new Error("fail"));
      render([makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" })]);

      await act(async () => {
        await hookResult.resolvePermission("req-1", "deny");
      });

      expect(mockDeps.clearWaitingAssistantForThread).not.toHaveBeenCalled();
      expect(mockDeps.onError).toHaveBeenCalledWith("fail");
    });

    it("supports allow_always decision", async () => {
      render([makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" })]);

      await act(async () => {
        await hookResult.resolvePermission("req-1", "allow_always");
      });

      expect(mockDeps.startWaitingAssistant).toHaveBeenCalledWith("t1");
      expect(mockResolvePermission).toHaveBeenCalledWith("t1", {
        requestId: "req-1",
        decision: "allow_always",
      });
    });

    it("dedupes repeated permission resolution while request is in flight", async () => {
      let release: (() => void) | null = null;
      mockResolvePermission.mockImplementationOnce(() => new Promise<void>((resolve) => {
        release = resolve;
      }));
      render([makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" })]);

      const firstCall = hookResult.resolvePermission("req-1", "deny");
      const secondCall = hookResult.resolvePermission("req-1", "deny");

      expect(mockResolvePermission).toHaveBeenCalledTimes(1);
      const resolvePending = release as (() => void) | null;
      resolvePending?.();

      await act(async () => {
        await Promise.all([firstCall, secondCall]);
      });

      expect(mockResolvePermission).toHaveBeenCalledTimes(1);
    });
  });

  describe("answerQuestion", () => {
    it("calls mutation with answers", async () => {
      render([makeEvent(0, "question.requested", { requestId: "q-1", questions: [{ question: "Q?" }] })]);

      await act(async () => {
        await hookResult.answerQuestion("q-1", { "0": "My answer" });
      });

      expect(mockAnswerQuestion).toHaveBeenCalledWith("t1", {
        requestId: "q-1",
        answers: { "0": "My answer" },
      });
      expect(mockDeps.startWaitingAssistant).toHaveBeenCalledWith("t1");
    });

    it("does nothing when no thread is selected", async () => {
      render([], null);
      await act(async () => {
        await hookResult.answerQuestion("q-1", { "0": "answer" });
      });
      expect(mockAnswerQuestion).not.toHaveBeenCalled();
    });

    it("handles errors and clears waiting assistant", async () => {
      mockAnswerQuestion.mockRejectedValueOnce(new Error("Bad answer"));
      render([makeEvent(0, "question.requested", { requestId: "q-1", questions: [{ question: "Q?" }] })]);

      await act(async () => {
        await hookResult.answerQuestion("q-1", { "0": "answer" });
      });

      expect(mockDeps.clearWaitingAssistantForThread).toHaveBeenCalledWith("t1");
      expect(mockDeps.onError).toHaveBeenCalledWith("Bad answer");
    });
  });

  describe("dismissQuestion", () => {
    it("calls mutation and optimistically closes question", async () => {
      render([makeEvent(0, "question.requested", { requestId: "q-1", questions: [{ question: "Q?" }] })]);

      await act(async () => {
        await hookResult.dismissQuestion("q-1");
      });

      expect(mockDismissQuestion).toHaveBeenCalledWith("t1", { requestId: "q-1" });
      expect(mockDeps.startWaitingAssistant).toHaveBeenCalledWith("t1");
    });

    it("does nothing when no thread is selected", async () => {
      render([], null);
      await act(async () => {
        await hookResult.dismissQuestion("q-1");
      });
      expect(mockDismissQuestion).not.toHaveBeenCalled();
    });

    it("handles errors and restores closed question", async () => {
      mockDismissQuestion.mockRejectedValueOnce(new Error("Dismiss failed"));
      render([makeEvent(0, "question.requested", { requestId: "q-1", questions: [{ question: "Q?" }] })]);

      await act(async () => {
        await hookResult.dismissQuestion("q-1");
      });

      expect(mockDeps.clearWaitingAssistantForThread).toHaveBeenCalledWith("t1");
      expect(mockDeps.onError).toHaveBeenCalledWith("Dismiss failed");
    });
  });

  describe("handleApprovePlan", () => {
    it("calls approve mutation and optimistically hides plan", async () => {
      const events = [
        makeEvent(0, "plan.created", { content: "Plan content", filePath: ".claude/plans/plan.md" }),
        makeEvent(1, "chat.completed", {}),
      ];
      render(events);
      expect(hookResult.showPlanDecisionComposer).toBe(true);

      await act(async () => {
        await hookResult.handleApprovePlan();
      });

      expect(mockApprovePlan).toHaveBeenCalledWith("t1");
      expect(mockDeps.startWaitingAssistant).toHaveBeenCalledWith("t1");
      expect(hookResult.showPlanDecisionComposer).toBe(false);
    });

    it("does nothing when no thread is selected", async () => {
      render([], null);
      await act(async () => {
        await hookResult.handleApprovePlan();
      });
      expect(mockApprovePlan).not.toHaveBeenCalled();
    });

    it("handles errors", async () => {
      mockApprovePlan.mockRejectedValueOnce(new Error("Approve failed"));
      const events = [
        makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
        makeEvent(1, "chat.completed", {}),
      ];
      render(events);

      await act(async () => {
        await hookResult.handleApprovePlan();
      });

      expect(mockDeps.clearWaitingAssistantForThread).toHaveBeenCalledWith("t1");
      expect(mockDeps.onError).toHaveBeenCalledWith("Approve failed");
    });
  });

  describe("handleRevisePlan", () => {
    it("calls revise mutation with feedback", async () => {
      const events = [
        makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
        makeEvent(1, "chat.completed", {}),
      ];
      render(events);

      await act(async () => {
        await hookResult.handleRevisePlan("Please add error handling");
      });

      expect(mockRevisePlan).toHaveBeenCalledWith("t1", { feedback: "Please add error handling" });
      expect(mockDeps.startWaitingAssistant).toHaveBeenCalledWith("t1");
      expect(hookResult.showPlanDecisionComposer).toBe(false);
    });

    it("does nothing when no thread is selected", async () => {
      render([], null);
      await act(async () => {
        await hookResult.handleRevisePlan("feedback");
      });
      expect(mockRevisePlan).not.toHaveBeenCalled();
    });

    it("handles errors", async () => {
      mockRevisePlan.mockRejectedValueOnce(new Error("Revise failed"));
      const events = [
        makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
        makeEvent(1, "chat.completed", {}),
      ];
      render(events);

      await act(async () => {
        await hookResult.handleRevisePlan("feedback");
      });

      expect(mockDeps.clearWaitingAssistantForThread).toHaveBeenCalledWith("t1");
      expect(mockDeps.onError).toHaveBeenCalledWith("Revise failed");
    });
  });

  describe("handleDismissPlan", () => {
    it("optimistically hides plan decision", () => {
      const events = [
        makeEvent(0, "plan.created", { content: "Plan", filePath: ".claude/plans/plan.md" }),
        makeEvent(1, "chat.completed", {}),
      ];
      render(events);
      expect(hookResult.showPlanDecisionComposer).toBe(true);

      act(() => {
        hookResult.handleDismissPlan();
      });
      expect(hookResult.showPlanDecisionComposer).toBe(false);
    });

    it("does nothing when no thread or plan", () => {
      render([], null);
      act(() => {
        hookResult.handleDismissPlan();
      });
      expect(hookResult.showPlanDecisionComposer).toBe(false);
    });
  });

  describe("thread switching", () => {
    it("resets gate state when thread changes", () => {
      const events = [
        makeEvent(0, "permission.requested", { requestId: "req-1", toolName: "Bash" }),
      ];
      render(events, "t1");
      expect(hookResult.hasPendingPermissionRequests).toBe(true);

      // Re-render with different thread
      render([], "t2");
      expect(hookResult.planActionBusy).toBe(false);
    });
  });

  describe("streaming fallback plan handling", () => {
    it("handles streaming_fallback with matching real write", () => {
      const events = [
        makeEvent(0, "plan.created", {
          content: "Intro text",
          filePath: "synth-plan.md",
          source: "streaming_fallback",
        }),
        makeEvent(1, "tool.finished", {
          editTarget: ".claude/plans/my-plan.md",
          toolInput: { content: "Real plan content" },
        }),
        makeEvent(2, "chat.completed", {}),
      ];
      render(events);
      expect(hookResult.pendingPlan).not.toBeNull();
      expect(hookResult.pendingPlan?.content).toBe("Real plan content");
    });

    it("skips streaming_fallback without real write", () => {
      const events = [
        makeEvent(0, "plan.created", {
          content: "Intro only",
          filePath: "synth-plan.md",
          source: "streaming_fallback",
        }),
        makeEvent(1, "chat.completed", {}),
      ];
      render(events);
      expect(hookResult.pendingPlan).toBeNull();
    });

    it("treats streaming_fallback with a real plan filePath as normal plan.created", () => {
      const events = [
        makeEvent(0, "plan.created", {
          content: "Direct plan",
          filePath: ".claude/plans/my-plan.md",
          source: "streaming_fallback",
        }),
        makeEvent(1, "chat.completed", {}),
      ];
      render(events);
      expect(hookResult.pendingPlan).not.toBeNull();
      expect(hookResult.pendingPlan?.content).toBe("Direct plan");
    });
  });
});
