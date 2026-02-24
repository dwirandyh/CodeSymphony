import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent } from "@codesymphony/shared-types";
import { debugLog } from "../../../lib/debugLog";
import { useResolvePermission } from "../../../hooks/mutations/useResolvePermission";
import { useAnswerQuestion } from "../../../hooks/mutations/useAnswerQuestion";
import { useApprovePlan } from "../../../hooks/mutations/useApprovePlan";
import { useRevisePlan } from "../../../hooks/mutations/useRevisePlan";
import type { PendingPermissionRequest, PendingPlan, PendingQuestionRequest, QuestionItem } from "../types";
import { shortenReadTargetForDisplay } from "../exploreUtils";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEditTool(toolName: string): boolean {
  return /^(edit|multiedit|write)$/i.test(toolName.trim());
}

function extractEditTarget(toolName: string, toolInput: unknown): string | null {
  if (!isEditTool(toolName) || !isRecord(toolInput)) {
    return null;
  }

  const keyCandidates = ["file_path", "path", "file", "filepath", "target", "filename"];
  for (const key of keyCandidates) {
    const raw = toolInput[key];
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = raw.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

export interface PendingGatesDeps {
  onError: (msg: string | null) => void;
  startWaitingAssistant: (threadId: string) => void;
  clearWaitingAssistantForThread: (threadId: string) => void;
}

export function usePendingGates(
  events: ChatEvent[],
  selectedThreadId: string | null,
  deps: PendingGatesDeps,
) {
  const { onError, startWaitingAssistant, clearWaitingAssistantForThread } = deps;

  const resolvePermissionMutation = useResolvePermission();
  const answerQuestionMutation = useAnswerQuestion();
  const approvePlanMutation = useApprovePlan();
  const revisePlanMutation = useRevisePlan();

  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(() => new Set());
  const [answeringQuestionIds, setAnsweringQuestionIds] = useState<Set<string>>(() => new Set());
  const [planActionBusy, setPlanActionBusy] = useState(false);
  const [closedPlanDecision, setClosedPlanDecision] = useState<{ threadId: string; createdIdx: number } | null>(null);

  const prevPendingRef = useRef<{
    permIds: string; qIds: string;
    perms: PendingPermissionRequest[]; qs: PendingQuestionRequest[];
  }>({ permIds: "", qIds: "", perms: [], qs: [] });

  // Reset all gate-local state when switching threads so Thread A's
  // in-flight actions don't leak into Thread B.
  useEffect(() => {
    debugLog("usePendingGates", "thread reset effect", { selectedThreadId });
    setPlanActionBusy(false);
    setResolvingPermissionIds(new Set());
    setAnsweringQuestionIds(new Set());
    setClosedPlanDecision(null);
  }, [selectedThreadId]);

  // ── Pending permission + question requests (single pass) ──

  const { pendingPermissionRequests, pendingQuestionRequests } = useMemo(() => {
    const pendingPermById = new Map<string, PendingPermissionRequest>();
    const pendingQById = new Map<string, PendingQuestionRequest>();
    const orderedEvents = [...events].sort((a, b) => a.idx - b.idx);

    for (const event of orderedEvents) {
      // Permission events
      if (event.type === "permission.requested") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length === 0) continue;
        const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "Tool";
        const toolInput = isRecord(event.payload.toolInput) ? event.payload.toolInput : null;
        const editTargetRaw = extractEditTarget(toolName, toolInput);
        const editTarget = editTargetRaw ? shortenReadTargetForDisplay(editTargetRaw) : null;

        pendingPermById.set(requestId, {
          requestId,
          toolName,
          command: typeof event.payload.command === "string" ? event.payload.command : null,
          editTarget,
          blockedPath: typeof event.payload.blockedPath === "string" ? event.payload.blockedPath : null,
          decisionReason: typeof event.payload.decisionReason === "string" ? event.payload.decisionReason : null,
          idx: event.idx,
        });
        continue;
      }

      if (event.type === "permission.resolved") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length > 0) pendingPermById.delete(requestId);
      }

      // Question events
      if (event.type === "question.requested") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length === 0) continue;

        const rawQuestions = Array.isArray(event.payload.questions) ? event.payload.questions : [];
        const questions: QuestionItem[] = rawQuestions.map((q: Record<string, unknown>) => ({
          question: typeof q.question === "string" ? q.question : "",
          header: typeof q.header === "string" ? q.header : undefined,
          options: Array.isArray(q.options)
            ? q.options.map((o: Record<string, unknown>) => ({
              label: typeof o.label === "string" ? o.label : "",
              description: typeof o.description === "string" ? o.description : undefined,
            }))
            : undefined,
          multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
        }));

        pendingQById.set(requestId, { requestId, questions, idx: event.idx });
        continue;
      }

      if (event.type === "question.answered") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length > 0) pendingQById.delete(requestId);
      }

      // Terminal events clear both
      if (event.type === "chat.completed" || event.type === "chat.failed") {
        pendingPermById.clear();
        pendingQById.clear();
      }
    }

    const newPermRequests = Array.from(pendingPermById.values()).sort((a, b) => a.idx - b.idx);
    const newQRequests = Array.from(pendingQById.values()).sort((a, b) => a.idx - b.idx);

    const newPermIds = newPermRequests.map(r => r.requestId).join(",");
    const newQIds = newQRequests.map(r => r.requestId).join(",");
    if (newPermIds === prevPendingRef.current.permIds && newQIds === prevPendingRef.current.qIds) {
      return { pendingPermissionRequests: prevPendingRef.current.perms, pendingQuestionRequests: prevPendingRef.current.qs };
    }
    prevPendingRef.current = { permIds: newPermIds, qIds: newQIds, perms: newPermRequests, qs: newQRequests };

    return {
      pendingPermissionRequests: newPermRequests,
      pendingQuestionRequests: newQRequests,
    };
  }, [events]);

  async function resolvePermission(requestId: string, decision: "allow" | "allow_always" | "deny") {
    if (!selectedThreadId) return;

    if (decision !== "deny") startWaitingAssistant(selectedThreadId);
    setResolvingPermissionIds((current) => {
      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    onError(null);

    try {
      await resolvePermissionMutation.mutateAsync({
        threadId: selectedThreadId,
        input: { requestId, decision },
      });
    } catch (e) {
      if (decision !== "deny") clearWaitingAssistantForThread(selectedThreadId);
      onError(e instanceof Error ? e.message : "Failed to resolve permission");
    } finally {
      setResolvingPermissionIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  async function answerQuestion(requestId: string, answers: Record<string, string>) {
    if (!selectedThreadId) return;

    startWaitingAssistant(selectedThreadId);
    setAnsweringQuestionIds((current) => {
      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    onError(null);

    try {
      await answerQuestionMutation.mutateAsync({
        threadId: selectedThreadId,
        input: { requestId, answers },
      });
    } catch (e) {
      clearWaitingAssistantForThread(selectedThreadId);
      onError(e instanceof Error ? e.message : "Failed to answer question");
    } finally {
      setAnsweringQuestionIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  // ── Pending plan ──

  const pendingPlan = useMemo<PendingPlan | null>(() => {
    const orderedEvents = [...events].sort((a, b) => a.idx - b.idx);
    let latestPlan: PendingPlan | null = null;

    for (const event of orderedEvents) {
      if (event.type === "plan.created") {
        const content = typeof event.payload.content === "string" ? event.payload.content : "";
        const filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "";
        if (content.length > 0) {
          latestPlan = { content, filePath, createdIdx: event.idx, status: "pending" };
        }
      } else if (event.type === "plan.approved") {
        if (latestPlan) {
          latestPlan = {
            content: latestPlan.content,
            filePath: latestPlan.filePath,
            createdIdx: latestPlan.createdIdx,
            status: "approved",
          };
        }
      } else if (event.type === "plan.revision_requested") {
        if (latestPlan) {
          latestPlan = {
            content: latestPlan.content,
            filePath: latestPlan.filePath,
            createdIdx: latestPlan.createdIdx,
            status: "sending",
          };
        }
      }
    }

    return latestPlan;
  }, [events]);

  // Only show the plan decision composer after the run has completed.
  // `plan.created` fires mid-run (inside `canUseTool`), but Claude SDK
  // continues trying more tools (all denied) before `chat.completed`.
  const isRunCompletedAfterPlan = useMemo(() => {
    if (!pendingPlan || pendingPlan.status !== "pending") return true;
    const orderedEvents = [...events].sort((a, b) => a.idx - b.idx);
    for (const event of orderedEvents) {
      if (
        event.idx > pendingPlan.createdIdx &&
        (event.type === "chat.completed" || event.type === "chat.failed")
      ) {
        return true;
      }
    }
    return false;
  }, [events, pendingPlan]);

  async function handleApprovePlan() {
    if (!selectedThreadId) return;

    startWaitingAssistant(selectedThreadId);
    setPlanActionBusy(true);
    onError(null);

    try {
      await approvePlanMutation.mutateAsync(selectedThreadId);
      if (pendingPlan) {
        setClosedPlanDecision({ threadId: selectedThreadId, createdIdx: pendingPlan.createdIdx });
      }
    } catch (e) {
      clearWaitingAssistantForThread(selectedThreadId);
      onError(e instanceof Error ? e.message : "Failed to approve plan");
    } finally {
      setPlanActionBusy(false);
    }
  }

  async function handleRevisePlan(feedback: string) {
    if (!selectedThreadId) return;

    startWaitingAssistant(selectedThreadId);
    setPlanActionBusy(true);
    onError(null);

    try {
      await revisePlanMutation.mutateAsync({
        threadId: selectedThreadId,
        input: { feedback },
      });
      if (pendingPlan) {
        setClosedPlanDecision({ threadId: selectedThreadId, createdIdx: pendingPlan.createdIdx });
      }
    } catch (e) {
      clearWaitingAssistantForThread(selectedThreadId);
      onError(e instanceof Error ? e.message : "Failed to revise plan");
    } finally {
      setPlanActionBusy(false);
    }
  }

  function handleDismissPlan() {
    if (!selectedThreadId || !pendingPlan) return;
    setClosedPlanDecision({ threadId: selectedThreadId, createdIdx: pendingPlan.createdIdx });
  }

  // ── Derived ──

  const hasPendingPermissionRequests = pendingPermissionRequests.length > 0;
  const hasPendingQuestionRequests = pendingQuestionRequests.length > 0;
  const hasPendingPlan = pendingPlan !== null && pendingPlan.status === "pending";

  const hidePlanDecisionByOptimisticClose =
    hasPendingPlan &&
    selectedThreadId != null &&
    closedPlanDecision?.threadId === selectedThreadId &&
    closedPlanDecision.createdIdx === pendingPlan!.createdIdx;

  const showPlanDecisionComposer = hasPendingPlan && !hidePlanDecisionByOptimisticClose && !hasPendingQuestionRequests && !hasPendingPermissionRequests && isRunCompletedAfterPlan;

  const isWaitingForUserGate = hasPendingPermissionRequests || hasPendingQuestionRequests || showPlanDecisionComposer;

  return {
    pendingPermissionRequests,
    pendingQuestionRequests,
    pendingPlan,
    resolvingPermissionIds,
    answeringQuestionIds,
    planActionBusy,
    showPlanDecisionComposer,
    isWaitingForUserGate,
    hasPendingPermissionRequests,
    hasPendingQuestionRequests,
    resolvePermission,
    answerQuestion,
    handleApprovePlan,
    handleRevisePlan,
    handleDismissPlan,
  };
}
