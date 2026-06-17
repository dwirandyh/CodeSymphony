import type { IssueReportClientDebugEntry } from "@codesymphony/shared-types";
import { debugLog } from "./debugLog";

const ISSUE_REPORT_CLIENT_DEBUG_MAX = 500;

const STORAGE_KEY = "codesymphony.workspaceDiagnose";

let cachedEnabled: boolean | null = null;

export function isWorkspaceUiDiagnoseEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (cachedEnabled != null) {
    return cachedEnabled;
  }

  try {
    const query = new URLSearchParams(window.location.search);
    const queryValue = query.get("workspaceDiagnose")?.trim().toLowerCase();
    if (queryValue === "1" || queryValue === "true") {
      cachedEnabled = true;
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)?.trim().toLowerCase();
    cachedEnabled = stored === "1" || stored === "true";
    return cachedEnabled;
  } catch {
    cachedEnabled = false;
    return false;
  }
}

export type WorkspaceEmptyStateDiagnostic = {
  surface: string;
  threadId?: string | null;
  resolved: string | null;
  timelineItemCount?: number;
  messageCount?: number;
  eventCount?: number;
  statusPending?: boolean;
  timelinePending?: boolean;
  legacyWouldShowLoading?: boolean;
  threadSnapshotLoading?: boolean;
  threadSnapshotFetching?: boolean;
  queriedThreadSnapshotPresent?: boolean;
  threadStatusSnapshotLoading?: boolean;
  threadStatusSnapshotFetching?: boolean;
  composerDisabled?: boolean;
  focusSignal?: number;
  extra?: Record<string, unknown>;
};

export function logWorkspaceEmptyStateResolution(
  surface: string,
  payload: Omit<WorkspaceEmptyStateDiagnostic, "surface">,
) {
  if (!isWorkspaceUiDiagnoseEnabled()) {
    return;
  }

  debugLog(
    "workspace.ui.emptyState",
    "resolved",
    { surface, ...payload },
    {
      threadId: payload.threadId ?? null,
      force: true,
    },
  );
}

export type TabAlignmentRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
};

export type WorkspaceTabAlignmentDiagnostic = {
  layout: "single" | "split";
  dividerPositionPercent?: number;
  selectedTabBottom?: number | null;
  gutterLeft?: number | null;
  gutterRight?: number | null;
  gutterWidth?: number | null;
  tabUnderlineDeltaPx?: number | null;
  mergeWithContent?: boolean;
  rects?: Record<string, TabAlignmentRect | null>;
};

export function logWorkspaceTabAlignment(payload: WorkspaceTabAlignmentDiagnostic) {
  if (!isWorkspaceUiDiagnoseEnabled()) {
    return;
  }

  debugLog("workspace.ui.tabAlignment", "geometry", payload, { force: true });
}

/** High-signal UI snapshot for issue reports (no workspaceDiagnose opt-in). */
export function logWorkspaceUiIssueReportSignal(
  message: string,
  data: Record<string, unknown>,
  options?: { threadId?: string | null; worktreeId?: string | null },
) {
  debugLog("workspace.ui.issueReport", message, data, {
    threadId: options?.threadId ?? null,
    worktreeId: options?.worktreeId ?? null,
    force: true,
  });
}

function roundPx(value: number): number {
  return Math.round(value * 10) / 10;
}

function rectSnapshot(element: Element | null | undefined): TabAlignmentRect | null {
  if (!element) {
    return null;
  }
  const r = element.getBoundingClientRect();
  return {
    left: roundPx(r.left),
    right: roundPx(r.right),
    top: roundPx(r.top),
    bottom: roundPx(r.bottom),
    width: roundPx(r.width),
  };
}

export function probeSplitTabStripAlignment(dividerPositionPercent: number) {
  if (!isWorkspaceUiDiagnoseEnabled()) {
    return;
  }

  const root = document.querySelector('[data-testid="split-tab-strips"]');
  const gutter = document.querySelector('[data-testid="split-tab-strips-divider-gutter"]');
  const selectedTab = document.querySelector(
    '[data-testid="split-tab-strips"] [data-tab-selected="true"],'
    + ' [data-testid="split-tab-strips"] .border-b-primary',
  );

  const gutterRect = rectSnapshot(gutter);
  const tabRect = rectSnapshot(selectedTab);
  const tabUnderlineDeltaPx =
    tabRect && gutterRect
      ? roundPx(Math.abs(tabRect.right - gutterRect.left))
      : null;

  logWorkspaceTabAlignment({
    layout: "split",
    dividerPositionPercent,
    selectedTabBottom: tabRect?.bottom ?? null,
    gutterLeft: gutterRect?.left ?? null,
    gutterRight: gutterRect?.right ?? null,
    gutterWidth: gutterRect?.width ?? null,
    tabUnderlineDeltaPx,
    rects: {
      gutter: gutterRect,
      selectedTab: tabRect,
      root: rectSnapshot(root),
    },
  });
}

export function probeSingleHeaderTabAlignment(mergeWithContent?: boolean) {
  if (!isWorkspaceUiDiagnoseEnabled()) {
    return;
  }

  const header = document.querySelector(".workspace-header");
  const selectedTab = document.querySelector(
    ".workspace-header .border-b-primary",
  );
  const contentShell = document.querySelector('[data-testid="workspace-main-content"]')
    ?? document.querySelector('[data-testid="chat-scroll"]')?.parentElement;

  const tabRect = rectSnapshot(selectedTab);
  const contentRect = rectSnapshot(contentShell);
  const headerRect = rectSnapshot(header);

  logWorkspaceTabAlignment({
    layout: "single",
    mergeWithContent: mergeWithContent ?? false,
    selectedTabBottom: tabRect?.bottom ?? null,
    tabUnderlineDeltaPx:
      tabRect && contentRect
        ? roundPx(tabRect.bottom - contentRect.top)
        : null,
    rects: {
      header: headerRect,
      selectedTab: tabRect,
      content: contentRect,
    },
  });
}

export function scheduleWorkspaceUiGeometryProbe(
  fn: () => void,
  delayMs = 0,
) {
  if (!isWorkspaceUiDiagnoseEnabled()) {
    return;
  }

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      if (delayMs > 0) {
        window.setTimeout(fn, delayMs);
        return;
      }
      fn();
    });
    return;
  }

  window.setTimeout(fn, delayMs);
}

/** Client buffer shipped with in-app issue reports (server merges + priority-filters). */
export function collectIssueReportClientDebugEntries(): IssueReportClientDebugEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  const buffer = window.__CS_DEBUG_LOG__ ?? [];
  return buffer.slice(-ISSUE_REPORT_CLIENT_DEBUG_MAX).map((entry) => ({
    seq: entry.seq,
    ts: entry.ts,
    source: entry.source,
    message: entry.message,
    data: entry.data,
  }));
}