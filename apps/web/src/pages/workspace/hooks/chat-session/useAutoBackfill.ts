import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
} from "react";
import type { ChatThreadSnapshot } from "@codesymphony/shared-types";
import { debugLog } from "../../../../lib/debugLog";
import type {
  AutoBackfillLoopInput,
  AutoBackfillLoopOutcome,
  HydrationBackfillPolicy,
  LoadOlderHistoryResult,
  SemanticHydrationGateMetadata,
} from "./useChatSession.types";
import {
  buildAutoBackfillLaunchKey,
  buildAutoBackfillSnapshotKey,
  shouldAutoBackfillOnHydration,
} from "./hydrationUtils";

const AUTO_BACKFILL_MAX_PAGES = 4;
const AUTO_BACKFILL_MAX_LAUNCHES_PER_THREAD = 16;
const AUTO_HYDRATION_MAX_INITIAL_GAP = 120;
const AUTO_HYDRATION_LARGE_GAP_EVENTS_LIMIT = 300;
const AUTO_HYDRATION_LARGE_GAP_MAX_PAGES = 2;

export async function runAutoBackfillLoop(input: AutoBackfillLoopInput): Promise<AutoBackfillLoopOutcome> {
  let pagesLoaded = 0;
  let previousBeforeIdx: number | null = input.getBeforeIdx();

  while (pagesLoaded < input.maxPages) {
    if (input.shouldAbort()) {
      return { pagesLoaded, stopReason: "abort", semanticBoundary: null };
    }

    if (input.isLoadingOlderHistory()) {
      return { pagesLoaded, stopReason: "loading-older-history", semanticBoundary: null };
    }

    if (input.isAutoBackfillAllowed && !input.isAutoBackfillAllowed()) {
      return { pagesLoaded, stopReason: "timeline-complete", semanticBoundary: null };
    }

    const beforeIdx = input.getBeforeIdx();
    if (beforeIdx == null) {
      return { pagesLoaded, stopReason: "no-more-events", semanticBoundary: null };
    }

    const result = await input.loadOlderHistoryPage(pagesLoaded + 1);
    pagesLoaded += 1;

    if (!result) {
      return { pagesLoaded, stopReason: "no-result", semanticBoundary: null };
    }

    if (result.completionReason === "empty-cursors") {
      return { pagesLoaded, stopReason: "empty-cursors", semanticBoundary: result.semanticBoundary };
    }

    if (result.completionReason !== "applied") {
      return { pagesLoaded, stopReason: "completion-reason", semanticBoundary: result.semanticBoundary };
    }

    const nextBeforeIdx = input.getBeforeIdx();
    const cursorAdvanced = nextBeforeIdx == null
      ? previousBeforeIdx != null
      : previousBeforeIdx != null && nextBeforeIdx < previousBeforeIdx;
    if (result.eventsAdded === 0 || !cursorAdvanced) {
      return { pagesLoaded, stopReason: "no-progress", semanticBoundary: result.semanticBoundary };
    }

    if (input.stopOnSemanticBoundary && result.semanticBoundaryDetected) {
      return {
        pagesLoaded,
        stopReason: "semantic-boundary-detected",
        semanticBoundary: result.semanticBoundary,
      };
    }

    previousBeforeIdx = nextBeforeIdx;

    if (!input.stopOnSemanticBoundary && !input.isTimelineIncomplete()) {
      return { pagesLoaded, stopReason: "timeline-complete", semanticBoundary: result.semanticBoundary };
    }
  }

  return { pagesLoaded, stopReason: "max-pages", semanticBoundary: null };
}

export interface UseAutoBackfillParams {
  selectedThreadId: string | null;
  queriedThreadSnapshot: ChatThreadSnapshot | undefined;
  hydrationBackfillPolicy: HydrationBackfillPolicy;
  timelineHasIncompleteCoverage: boolean;
  loadingOlderHistoryRef: MutableRefObject<boolean>;
  activeThreadIdRef: MutableRefObject<string | null>;
  nextBeforeIdxByThreadRef: MutableRefObject<Map<string, number | null>>;
  seededSnapshotKeyByThreadRef: MutableRefObject<Map<string, string>>;
  lastAppliedSnapshotKeyByThreadRef: MutableRefObject<Map<string, string>>;
  autoBackfillRunTokenByThreadRef: MutableRefObject<Map<string, number>>;
  autoBackfillRequestCounterRef: MutableRefObject<number>;
  lastAutoBackfillLaunchKeyByThreadRef: MutableRefObject<Map<string, string>>;
  autoBackfillInFlightLaunchKeyByThreadRef: MutableRefObject<Map<string, string>>;
  autoBackfillLaunchCountByThreadRef: MutableRefObject<Map<string, number>>;
  autoBackfillLaunchSnapshotKeyByThreadRef: MutableRefObject<Map<string, string>>;
  autoBackfillLastLaunchConsumptionReasonByThreadRef: MutableRefObject<Map<string, "normal-stop" | "productive-abort">>;
  autoBackfillEffectSignatureRef: MutableRefObject<{
    threadId: string;
    snapshotKey: string;
    timelineIncompleteCoverage: boolean;
  } | null>;
  timelineIncompleteCoverageRef: MutableRefObject<boolean>;
  loadOlderHistoryFnRef: MutableRefObject<(metadata?: { cycleId?: number; requestId?: string; source?: "manual" | "auto-hydration"; eventsLimitOverride?: number }) => Promise<LoadOlderHistoryResult | void>>;
  openSemanticHydrationGate: (metadata: SemanticHydrationGateMetadata) => void;
  closeSemanticHydrationGate: (metadata: SemanticHydrationGateMetadata) => void;
}

export function useAutoBackfill(params: UseAutoBackfillParams) {
  const {
    selectedThreadId,
    queriedThreadSnapshot,
    hydrationBackfillPolicy,
    timelineHasIncompleteCoverage,
    loadingOlderHistoryRef,
    activeThreadIdRef,
    nextBeforeIdxByThreadRef,
    seededSnapshotKeyByThreadRef,
    autoBackfillRunTokenByThreadRef,
    autoBackfillRequestCounterRef,
    lastAutoBackfillLaunchKeyByThreadRef,
    autoBackfillInFlightLaunchKeyByThreadRef,
    autoBackfillLaunchCountByThreadRef,
    autoBackfillLaunchSnapshotKeyByThreadRef,
    autoBackfillLastLaunchConsumptionReasonByThreadRef,
    autoBackfillEffectSignatureRef,
    timelineIncompleteCoverageRef,
    loadOlderHistoryFnRef,
    openSemanticHydrationGate,
    closeSemanticHydrationGate,
  } = params;

  const shouldAutoBackfillNow = useCallback(() => {
    if (!selectedThreadId || !queriedThreadSnapshot) {
      return false;
    }
    if (hydrationBackfillPolicy !== "auto") {
      return false;
    }
    return shouldAutoBackfillOnHydration(queriedThreadSnapshot, timelineIncompleteCoverageRef.current);
  }, [hydrationBackfillPolicy, queriedThreadSnapshot, selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId || !queriedThreadSnapshot) {
      autoBackfillEffectSignatureRef.current = null;
      return;
    }

    const coverage = queriedThreadSnapshot.coverage;
    const snapshotKey = buildAutoBackfillSnapshotKey(queriedThreadSnapshot);
    const lastSignature = autoBackfillEffectSignatureRef.current;
    const trigger: "initial-run" | "snapshot-key-change" | "timeline-incomplete-change" = lastSignature == null
      ? "initial-run"
      : lastSignature.threadId !== selectedThreadId || lastSignature.snapshotKey !== snapshotKey
        ? "snapshot-key-change"
        : "timeline-incomplete-change";
    autoBackfillEffectSignatureRef.current = {
      threadId: selectedThreadId,
      snapshotKey,
      timelineIncompleteCoverage: timelineHasIncompleteCoverage,
    };

    const launchKey = buildAutoBackfillLaunchKey({
      snapshotKey,
      coverageNextBeforeIdx: coverage.nextBeforeIdx,
      timelineHasIncompleteCoverage,
    });
    const inFlightLaunchKey = autoBackfillInFlightLaunchKeyByThreadRef.current.get(selectedThreadId) ?? null;
    const lastLaunchKey = lastAutoBackfillLaunchKeyByThreadRef.current.get(selectedThreadId) ?? null;

    debugLog("useChatSession", "autoBackfill effect cycle", {
      threadId: selectedThreadId,
      snapshotKey,
      launchKey,
      coverageNextBeforeIdx: coverage.nextBeforeIdx,
      timelineIncompleteCoverage: timelineHasIncompleteCoverage,
      loadingOlderHistoryRef: loadingOlderHistoryRef.current,
      inFlightLaunchKey,
      lastLaunchKey,
      selectedThreadId,
      trigger,
      reason: trigger,
    });

    const shouldAutoBackfill = shouldAutoBackfillOnHydration(
      queriedThreadSnapshot,
      timelineHasIncompleteCoverage,
    );

    if (!shouldAutoBackfill) {
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: "timeline-complete",
        hydrationBackfillPolicy,
      });
      return;
    }

    if (hydrationBackfillPolicy !== "auto") {
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: "policy-manual",
        hydrationBackfillPolicy,
        coverageEventsStatus: coverage.eventsStatus,
        coverageRecommendedBackfill: coverage.recommendedBackfill,
        coverageNextBeforeIdx: coverage.nextBeforeIdx,
        timelineIncompleteCoverage: timelineHasIncompleteCoverage,
      });
      return;
    }

    if (loadingOlderHistoryRef.current) {
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: "loading-older-history",
        hydrationBackfillPolicy,
      });
      return;
    }

    const launchBeforeIdx = nextBeforeIdxByThreadRef.current.get(selectedThreadId) ?? coverage.nextBeforeIdx ?? null;
    if (launchBeforeIdx == null) {
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: "empty-cursors",
        hydrationBackfillPolicy,
      });
      return;
    }

    const useBoundedLargeGapMode = !timelineHasIncompleteCoverage && launchBeforeIdx > AUTO_HYDRATION_MAX_INITIAL_GAP;
    const stopOnSemanticBoundary = useBoundedLargeGapMode;
    const eventsLimitOverride = useBoundedLargeGapMode ? AUTO_HYDRATION_LARGE_GAP_EVENTS_LIMIT : undefined;
    const maxPages = useBoundedLargeGapMode ? AUTO_HYDRATION_LARGE_GAP_MAX_PAGES : AUTO_BACKFILL_MAX_PAGES;

    const lastSeededSnapshotKey = seededSnapshotKeyByThreadRef.current.get(selectedThreadId) ?? null;
    if (lastSeededSnapshotKey !== snapshotKey) {
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: "snapshot-not-seeded-yet",
        hydrationBackfillPolicy,
        snapshotKey,
        lastSeededSnapshotKey,
      });
      return;
    }

    if (inFlightLaunchKey === launchKey) {
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: "launch-key-in-flight",
        hydrationBackfillPolicy,
        launchKey,
      });
      return;
    }

    if (lastLaunchKey === launchKey) {
      const consumedReason = autoBackfillLastLaunchConsumptionReasonByThreadRef.current.get(selectedThreadId) ?? null;
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: consumedReason === "productive-abort"
          ? "same-launch-key-after-productive-abort"
          : "same-launch-key",
        hydrationBackfillPolicy,
        launchKey,
      });
      return;
    }

    const previousLaunchSnapshotKey = autoBackfillLaunchSnapshotKeyByThreadRef.current.get(selectedThreadId) ?? null;
    const previousLaunchCount = autoBackfillLaunchCountByThreadRef.current.get(selectedThreadId) ?? 0;
    const nextLaunchCount = previousLaunchSnapshotKey === snapshotKey ? previousLaunchCount + 1 : 1;
    autoBackfillLaunchCountByThreadRef.current.set(selectedThreadId, nextLaunchCount);
    autoBackfillLaunchSnapshotKeyByThreadRef.current.set(selectedThreadId, snapshotKey);
    if (nextLaunchCount > AUTO_BACKFILL_MAX_LAUNCHES_PER_THREAD) {
      debugLog("useChatSession", "autoBackfill launch skipped", {
        threadId: selectedThreadId,
        reason: "launch-cap-reached",
        hydrationBackfillPolicy,
        launchKey,
        launchCount: nextLaunchCount,
      });
      return;
    }

    autoBackfillInFlightLaunchKeyByThreadRef.current.set(selectedThreadId, launchKey);

    const nextToken = (autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0) + 1;
    autoBackfillRunTokenByThreadRef.current.set(selectedThreadId, nextToken);

    const runSequence = autoBackfillRequestCounterRef.current + 1;
    autoBackfillRequestCounterRef.current = runSequence;
    const cycleId = runSequence;
    const cyclePrefix = `auto-backfill-${selectedThreadId}-${runSequence}`;

    let cancelled = false;

    const semanticHydrationGateMetadata: SemanticHydrationGateMetadata = {
      threadId: selectedThreadId,
      reason: "auto-backfill",
      source: "auto-backfill",
      cycleId,
      launchKey,
    };

    void (async () => {
      openSemanticHydrationGate(semanticHydrationGateMetadata);
      debugLog("useChatSession", "autoBackfill launch", {
        threadId: selectedThreadId,
        cycleId,
        launchKey,
        snapshotKey,
        launchBeforeIdx,
        hydrationBackfillPolicy,
        coverageEventsStatus: coverage.eventsStatus,
        coverageRecommendedBackfill: coverage.recommendedBackfill,
        coverageNextBeforeIdx: coverage.nextBeforeIdx,
        timelineIncompleteCoverage: timelineHasIncompleteCoverage,
        launchCount: nextLaunchCount,
        boundedLargeGapMode: useBoundedLargeGapMode,
        stopOnSemanticBoundary,
        maxPages,
        eventsLimitOverride: eventsLimitOverride ?? null,
      });

      const outcome = await runAutoBackfillLoop({
        maxPages,
        shouldAbort: () => {
          const activeToken = autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0;
          return cancelled || activeToken !== nextToken || activeThreadIdRef.current !== selectedThreadId;
        },
        isLoadingOlderHistory: () => loadingOlderHistoryRef.current,
        isAutoBackfillAllowed: shouldAutoBackfillNow,
        stopOnSemanticBoundary,
        getBeforeIdx: () => nextBeforeIdxByThreadRef.current.get(selectedThreadId) ?? null,
        loadOlderHistoryPage: (pageNumber) => loadOlderHistoryFnRef.current({
          cycleId,
          requestId: `${cyclePrefix}-page-${pageNumber}`,
          source: "auto-hydration",
          eventsLimitOverride,
        }),
        isTimelineIncomplete: () => timelineIncompleteCoverageRef.current,
      });

      const treatAsConsumedLaunch = outcome.stopReason !== "abort" || outcome.pagesLoaded > 0;
      if (treatAsConsumedLaunch) {
        lastAutoBackfillLaunchKeyByThreadRef.current.set(selectedThreadId, launchKey);
      }

      const consumedReason = outcome.stopReason === "abort" && outcome.pagesLoaded > 0
        ? "productive-abort"
        : outcome.stopReason === "abort"
          ? "non-productive-abort"
          : "normal-stop";

      if (treatAsConsumedLaunch && consumedReason === "productive-abort") {
        autoBackfillLastLaunchConsumptionReasonByThreadRef.current.set(selectedThreadId, "productive-abort");
      } else if (outcome.stopReason !== "abort") {
        autoBackfillLastLaunchConsumptionReasonByThreadRef.current.set(selectedThreadId, "normal-stop");
      }

      if (outcome.stopReason === "abort") {
        debugLog("useChatSession", "autoBackfill abort handling", {
          threadId: selectedThreadId,
          launchKey,
          pagesLoaded: outcome.pagesLoaded,
          eventsAddedTotal: null,
          treatAsConsumedLaunch,
          consumedReason,
        });
      }

      debugLog("useChatSession", "autoBackfill stop", {
        threadId: selectedThreadId,
        cycleId,
        launchKey,
        snapshotKey,
        hydrationBackfillPolicy,
        stopReason: outcome.stopReason,
        pagesLoaded: outcome.pagesLoaded,
        semanticBoundaryKind: outcome.semanticBoundary?.kind ?? null,
        semanticBoundaryEventId: outcome.semanticBoundary?.eventId ?? null,
        semanticBoundaryEventIdx: outcome.semanticBoundary?.eventIdx ?? null,
        semanticBoundaryEventType: outcome.semanticBoundary?.eventType ?? null,
      });

      debugLog("useChatSession", "autoBackfill end", {
        threadId: selectedThreadId,
        cycleId,
        launchKey,
        hydrationBackfillPolicy,
        pagesLoaded: outcome.pagesLoaded,
      });
    })().finally(() => {
      const currentInFlightLaunchKey = autoBackfillInFlightLaunchKeyByThreadRef.current.get(selectedThreadId) ?? null;
      if (currentInFlightLaunchKey === launchKey) {
        autoBackfillInFlightLaunchKeyByThreadRef.current.delete(selectedThreadId);
      }
      closeSemanticHydrationGate(semanticHydrationGateMetadata);
    });

    return () => {
      const activeThreadId = activeThreadIdRef.current;
      const cleanupReason: "dependency-rerun" | "thread-switch" | "unmount" = activeThreadId == null
        ? "unmount"
        : activeThreadId !== selectedThreadId
          ? "thread-switch"
          : "dependency-rerun";
      const tokenBefore = autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0;
      cancelled = true;
      const currentToken = autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0;
      if (currentToken === nextToken) {
        autoBackfillRunTokenByThreadRef.current.set(selectedThreadId, nextToken + 1);
      }
      const tokenAfter = autoBackfillRunTokenByThreadRef.current.get(selectedThreadId) ?? 0;
      debugLog("useChatSession", "autoBackfill effect cleanup", {
        threadId: selectedThreadId,
        launchKey,
        tokenBefore,
        tokenAfter,
        cancelled,
        cleanupReason,
      });
    };
  }, [
    closeSemanticHydrationGate,
    hydrationBackfillPolicy,
    openSemanticHydrationGate,
    queriedThreadSnapshot,
    selectedThreadId,
    shouldAutoBackfillNow,
    timelineHasIncompleteCoverage,
  ]);

  return { shouldAutoBackfillNow };
}
