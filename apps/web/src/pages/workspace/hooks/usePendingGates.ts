import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovePlanInput, ApprovePlanResult, ChatEvent } from "@codesymphony/shared-types";
import { useLiveQuery } from "@tanstack/react-db";
import { api } from "../../../lib/api";
import { getThreadCollections } from "../../../collections/threadCollections";
import type { PendingPermissionRequest, PendingPlan, PendingQuestionRequest } from "../types";
import {
  derivePendingPermissionRequests,
  derivePendingPlan,
  derivePendingQuestionRequests,
  isPlanReviewReady,
} from "./worktreeThreadStatus";

const EMPTY_EVENTS: ChatEvent[] = [];

function cloneEventsSortedIfNeeded(events: ChatEvent[]): ChatEvent[] {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].idx > events[index].idx) {
      return [...events].sort((left, right) => left.idx - right.idx);
    }
  }

  return events;
}

export interface PendingGatesDeps {
  onError: (msg: string | null) => void;
  startWaitingAssistant: (threadId: string) => void;
  clearWaitingAssistantForThread: (threadId: string) => void;
  onPlanApproved?: (result: ApprovePlanResult) => void;
}

export function usePendingGates(
  selectedThreadId: string | null,
  deps: PendingGatesDeps,
) {
  const { onError, startWaitingAssistant, clearWaitingAssistantForThread } = deps;
  const { data: liveEvents } = useLiveQuery(
    () => selectedThreadId ? getThreadCollections(selectedThreadId).eventsCollection : undefined,
    [selectedThreadId],
  );
  const events = useMemo(
    () => liveEvents ? cloneEventsSortedIfNeeded(liveEvents as ChatEvent[]) : EMPTY_EVENTS,
    [liveEvents],
  );

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

  // Reset all gate-local state when switching threads so Thread A's
  // in-flight actions don't leak into Thread B.
  useEffect(() => {
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

    prevPendingRef.current = { permIds: newPermIds, qIds: newQIds, perms: newPermRequests, qs: newQRequests };

    return {
      pendingPermissionRequests: newPermRequests,
      pendingQuestionRequests: newQRequests,
    };
  }, [events, closedQuestionsByThread, selectedThreadId]);

  async function resolvePermission(requestId: string, decision: "allow" | "allow_always" | "deny") {
    if (!selectedThreadId) return;
    if (inFlightPermissionIdsRef.current.has(requestId)) {
      return;
    }

    inFlightPermissionIdsRef.current.add(requestId);

    if (decision !== "deny") startWaitingAssistant(selectedThreadId);
    setResolvingPermissionIds((current) => {
      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    onError(null);

    try {
      await api.resolvePermission(selectedThreadId, { requestId, decision });
    } catch (e) {
      if (decision !== "deny") clearWaitingAssistantForThread(selectedThreadId);
      onError(e instanceof Error ? e.message : "Failed to resolve permission");
    } finally {
      inFlightPermissionIdsRef.current.delete(requestId);
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

  // Only show the plan decision composer after Claude has fully exited
  // plan mode. Older histories may only have chat completion, so keep a
  // completion fallback for those snapshots.
  const isPlanReadyForReview = useMemo(() => isPlanReviewReady(events, pendingPlan), [events, pendingPlan]);

  async function handleApprovePlan(input: ApprovePlanInput) {
    if (!selectedThreadId) return;

    startWaitingAssistant(selectedThreadId);
    setPlanActionBusy(true);
    onError(null);

    try {
      const result = await api.approvePlan(selectedThreadId, input);
      if (pendingPlan) {
        setClosedPlanDecision({ threadId: selectedThreadId, createdIdx: pendingPlan.createdIdx });
      }
      deps.onPlanApproved?.(result);
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

  async function handleDismissPlan() {
    if (!selectedThreadId || !pendingPlan) return;

    const nextClosedPlanDecision = { threadId: selectedThreadId, createdIdx: pendingPlan.createdIdx };
    setClosedPlanDecision(nextClosedPlanDecision);
    setPlanActionBusy(true);
    onError(null);

    try {
      await api.dismissPlan(selectedThreadId);
    } catch (e) {
      setClosedPlanDecision((current) => (
        current?.threadId === nextClosedPlanDecision.threadId
        && current.createdIdx === nextClosedPlanDecision.createdIdx
          ? null
          : current
      ));
      onError(e instanceof Error ? e.message : "Failed to dismiss plan");
    } finally {
      setPlanActionBusy(false);
    }
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

  const showPlanDecisionComposer = hasPendingPlan
    && !hidePlanDecisionByOptimisticClose
    && !hasPendingQuestionRequests
    && !hasPendingPermissionRequests
    && isPlanReadyForReview;

  const isWaitingForUserGate = hasPendingPermissionRequests || hasPendingQuestionRequests || showPlanDecisionComposer;


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
