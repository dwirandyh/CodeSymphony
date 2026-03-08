import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent } from "@codesymphony/shared-types";
import { debugLog } from "../../../lib/debugLog";
import { api } from "../../../lib/api";
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

  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(() => new Set());
  const [answeringQuestionIds, setAnsweringQuestionIds] = useState<Set<string>>(() => new Set());
  const [dismissingQuestionIds, setDismissingQuestionIds] = useState<Set<string>>(() => new Set());
  const [planActionBusy, setPlanActionBusy] = useState(false);
  const [closedPlanDecision, setClosedPlanDecision] = useState<{ threadId: string; createdIdx: number } | null>(null);
  const [closedQuestionsByThread, setClosedQuestionsByThread] = useState<Record<string, true>>({});
  const inFlightPermissionIdsRef = useRef<Set<string>>(new Set());

  const prevPendingRef = useRef<{
    permIds: string; qIds: string;
    perms: PendingPermissionRequest[]; qs: PendingQuestionRequest[];
  }>({ permIds: "", qIds: "", perms: [], qs: [] });
  const derivationChurnRef = useRef<{
    signature: string;
    windowStartedAt: number;
    toggleCount: number;
    lastLoggedAt: number;
    previousFlags: {
      hasPendingPermissionRequests: boolean;
      hasPendingQuestionRequests: boolean;
      showPlanDecisionComposer: boolean;
      isWaitingForUserGate: boolean;
    } | null;
  }>({
    signature: "",
    windowStartedAt: 0,
    toggleCount: 0,
    lastLoggedAt: 0,
    previousFlags: null,
  });

  // Reset all gate-local state when switching threads so Thread A's
  // in-flight actions don't leak into Thread B.
  useEffect(() => {
    debugLog("usePendingGates", "thread reset effect", {
      selectedThreadId,
      inFlightPermissionIds: Array.from(inFlightPermissionIdsRef.current),
      resolvingPermissionIdsSize: resolvingPermissionIds.size,
      answeringQuestionIdsSize: answeringQuestionIds.size,
      dismissingQuestionIdsSize: dismissingQuestionIds.size,
    });
    setPlanActionBusy(false);
    inFlightPermissionIdsRef.current.clear();
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
    if (inFlightPermissionIdsRef.current.has(requestId)) {
      debugLog("usePendingGates", "resolve-permission:deduped", {
        selectedThreadId,
        requestId,
        decision,
      });
      return;
    }

    inFlightPermissionIdsRef.current.add(requestId);
    debugLog("usePendingGates", "resolve-permission:start", {
      selectedThreadId,
      requestId,
      decision,
      eventCount: events.length,
    });

    if (decision !== "deny") startWaitingAssistant(selectedThreadId);
    setResolvingPermissionIds((current) => {
      debugLog("usePendingGates", "resolve-permission:setResolvingPermissionIds:add", {
        selectedThreadId,
        requestId,
        decision,
        before: Array.from(current),
      });

      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    onError(null);

    try {
      await api.resolvePermission(selectedThreadId, { requestId, decision });
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
      inFlightPermissionIdsRef.current.delete(requestId);
      debugLog("usePendingGates", "resolve-permission:finally", {
        selectedThreadId,
        requestId,
        decision,
      });
      setResolvingPermissionIds((current) => {
        debugLog("usePendingGates", "resolve-permission:setResolvingPermissionIds:remove", {
          selectedThreadId,
          requestId,
          decision,
          before: Array.from(current),
        });
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
      await api.answerQuestion(selectedThreadId, { requestId, answers });
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
      await api.dismissQuestion(selectedThreadId, { requestId });
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
      await api.approvePlan(selectedThreadId);
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
      await api.revisePlan(selectedThreadId, { feedback });
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

    const permIds = pendingPermissionRequests.map((request) => request.requestId).join(",");
    const questionIds = pendingQuestionRequests.map((request) => request.requestId).join(",");
    const signature = `${selectedThreadId ?? "none"}|${permIds}|${questionIds}`;
    const currentFlags = {
      hasPendingPermissionRequests,
      hasPendingQuestionRequests,
      showPlanDecisionComposer,
      isWaitingForUserGate,
    };
    const churn = derivationChurnRef.current;
    const now = performance.now();

    if (churn.signature !== signature || now - churn.windowStartedAt > 1000) {
      churn.signature = signature;
      churn.windowStartedAt = now;
      churn.toggleCount = 0;
    }

    const previousFlags = churn.previousFlags;
    if (previousFlags) {
      const changedFlags = Object.entries(currentFlags)
        .filter(([key, value]) => previousFlags[key as keyof typeof currentFlags] !== value)
        .map(([key]) => key);
      if (changedFlags.length > 0) {
        churn.toggleCount += changedFlags.length;
        if (churn.toggleCount >= 4 && now - churn.lastLoggedAt > 1000) {
          churn.lastLoggedAt = now;
          debugLog("usePendingGates", "derivation-churn", {
            selectedThreadId,
            permissionIds: permIds.length > 0 ? permIds.split(",") : [],
            questionIds: questionIds.length > 0 ? questionIds.split(",") : [],
            eventCount: events.length,
            changedFlags,
            toggleCount: churn.toggleCount,
            previousFlags,
            currentFlags,
          });
        }
      }
    }

    churn.previousFlags = currentFlags;
  }, [
    answeringQuestionIds,
    dismissingQuestionIds,
    events.length,
    hasPendingPermissionRequests,
    hasPendingQuestionRequests,
    isWaitingForUserGate,
    pendingPermissionRequests,
    pendingQuestionRequests,
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
