import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent } from "@codesymphony/shared-types";
import { debugLog } from "../../../lib/debugLog";
import { useResolvePermission } from "../../../hooks/mutations/useResolvePermission";
import { useAnswerQuestion } from "../../../hooks/mutations/useAnswerQuestion";
import { useApprovePlan } from "../../../hooks/mutations/useApprovePlan";
import { useRevisePlan } from "../../../hooks/mutations/useRevisePlan";
import { useDismissQuestion } from "../../../hooks/mutations/useDismissQuestion";
import type { PendingPermissionRequest, PendingPlan, PendingQuestionRequest } from "../types";
import {
  derivePendingPermissionRequests,
  derivePendingPlan,
  derivePendingQuestionRequests,
  isRunCompletedAfterPlan,
} from "./worktreeThreadStatus";

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
  const dismissQuestionMutation = useDismissQuestion();

  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(() => new Set());
  const [answeringQuestionIds, setAnsweringQuestionIds] = useState<Set<string>>(() => new Set());
  const [dismissingQuestionIds, setDismissingQuestionIds] = useState<Set<string>>(() => new Set());
  const [planActionBusy, setPlanActionBusy] = useState(false);
  const [closedPlanDecision, setClosedPlanDecision] = useState<{ threadId: string; createdIdx: number } | null>(null);
  const [closedQuestionsByThread, setClosedQuestionsByThread] = useState<Record<string, true>>({});

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
    setDismissingQuestionIds(new Set());
    setClosedPlanDecision(null);
  }, [selectedThreadId]);

  // ── Pending permission + question requests (single pass) ──

  const { pendingPermissionRequests, pendingQuestionRequests } = useMemo(() => {
    const newPermRequests = derivePendingPermissionRequests(events);
    const newQRequests = derivePendingQuestionRequests(events)
      .filter((request) => !closedQuestionsByThread[request.requestId])
      .sort((a, b) => a.idx - b.idx);

    const newPermIds = newPermRequests.map((r) => r.requestId).join(",");
    const newQIds = newQRequests.map((r) => r.requestId).join(",");
    if (newPermIds === prevPendingRef.current.permIds && newQIds === prevPendingRef.current.qIds) {
      return { pendingPermissionRequests: prevPendingRef.current.perms, pendingQuestionRequests: prevPendingRef.current.qs };
    }

    debugLog("usePendingGates", "pending-gates-changed", {
      selectedThreadId,
      permissionIds: newPermRequests.map((request) => request.requestId),
      questionIds: newQRequests.map((request) => request.requestId),
      eventCount: events.length,
    });

    prevPendingRef.current = { permIds: newPermIds, qIds: newQIds, perms: newPermRequests, qs: newQRequests };

    return {
      pendingPermissionRequests: newPermRequests,
      pendingQuestionRequests: newQRequests,
    };
  }, [events, closedQuestionsByThread, selectedThreadId]);

  async function resolvePermission(requestId: string, decision: "allow" | "allow_always" | "deny") {
    if (!selectedThreadId) return;

    debugLog("usePendingGates", "resolve-permission:start", {
      selectedThreadId,
      requestId,
      decision,
      eventCount: events.length,
    });

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
      debugLog("usePendingGates", "resolve-permission:success", {
        selectedThreadId,
        requestId,
        decision,
      });
    } catch (e) {
      debugLog("usePendingGates", "resolve-permission:error", {
        selectedThreadId,
        requestId,
        decision,
        error: e instanceof Error ? e.message : String(e),
      });
      if (decision !== "deny") clearWaitingAssistantForThread(selectedThreadId);
      onError(e instanceof Error ? e.message : "Failed to resolve permission");
    } finally {
      debugLog("usePendingGates", "resolve-permission:finally", {
        selectedThreadId,
        requestId,
        decision,
      });
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

  async function dismissQuestion(requestId: string) {
    if (!selectedThreadId) return;

    startWaitingAssistant(selectedThreadId);
    setDismissingQuestionIds((current) => {
      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    setClosedQuestionsByThread((current) => ({
      ...current,
      [requestId]: true,
    }));
    onError(null);

    try {
      await dismissQuestionMutation.mutateAsync({
        threadId: selectedThreadId,
        input: { requestId },
      });
    } catch (e) {
      clearWaitingAssistantForThread(selectedThreadId);
      setClosedQuestionsByThread((current) => {
        if (!current[requestId]) {
          return current;
        }
        const next = { ...current };
        delete next[requestId];
        return next;
      });
      onError(e instanceof Error ? e.message : "Failed to dismiss question");
    } finally {
      setDismissingQuestionIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  // ── Pending plan ──

  const pendingPlan = useMemo<PendingPlan | null>(() => derivePendingPlan(events), [events]);

  // Only show the plan decision composer after the run has completed.
  // `plan.created` fires mid-run (inside `canUseTool`), but Claude SDK
  // continues trying more tools (all denied) before `chat.completed`.
  const isPlanRunCompleted = useMemo(() => isRunCompletedAfterPlan(events, pendingPlan), [events, pendingPlan]);

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

  const showPlanDecisionComposer = hasPendingPlan && !hidePlanDecisionByOptimisticClose && !hasPendingQuestionRequests && !hasPendingPermissionRequests && isPlanRunCompleted;

  const isWaitingForUserGate = hasPendingPermissionRequests || hasPendingQuestionRequests || showPlanDecisionComposer;

  useEffect(() => {
    debugLog("usePendingGates", "gate-flags", {
      selectedThreadId,
      hasPendingPermissionRequests,
      hasPendingQuestionRequests,
      showPlanDecisionComposer,
      isWaitingForUserGate,
      resolvingPermissionIds: Array.from(resolvingPermissionIds),
      answeringQuestionIds: Array.from(answeringQuestionIds),
      dismissingQuestionIds: Array.from(dismissingQuestionIds),
    });
  }, [
    answeringQuestionIds,
    dismissingQuestionIds,
    hasPendingPermissionRequests,
    hasPendingQuestionRequests,
    isWaitingForUserGate,
    resolvingPermissionIds,
    selectedThreadId,
    showPlanDecisionComposer,
  ]);

  return {
    pendingPermissionRequests,
    pendingQuestionRequests,
    pendingPlan,
    resolvingPermissionIds,
    answeringQuestionIds,
    dismissingQuestionIds,
    planActionBusy,
    showPlanDecisionComposer,
    isWaitingForUserGate,
    hasPendingPermissionRequests,
    hasPendingQuestionRequests,
    resolvePermission,
    answerQuestion,
    dismissQuestion,
    handleApprovePlan,
    handleRevisePlan,
    handleDismissPlan,
  };
}
