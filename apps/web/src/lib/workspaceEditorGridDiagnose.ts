import { logWorkspaceUiIssueReportSignal } from "./workspaceUiDiagnose";
import type { EditorGroupsState } from "../pages/workspace/editorGroups";
import type { EditorQuadrantId } from "../pages/workspace/editorGroupTypes";
import {
  gridLeftColumnSpansRows,
  quadrantsWithEditorChrome,
  resolveEditorGridVisualVariant,
} from "../pages/workspace/editorGridOccupancy";

const QUADRANTS: EditorQuadrantId[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

function roundPx(value: number): number {
  return Math.round(value * 10) / 10;
}

function rectOf(selector: string) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: roundPx(r.left),
    top: roundPx(r.top),
    width: roundPx(r.width),
    height: roundPx(r.height),
    bottom: roundPx(r.bottom),
    right: roundPx(r.right),
  };
}

export type EditorGridStateSnapshot = {
  layout: EditorGroupsState["layout"];
  splitMode: boolean;
  activeGroupId: EditorQuadrantId;
  gridLeftColumnSpansRows: boolean;
  gridVisualVariant: string;
  editorChromeQuadrants: EditorQuadrantId[];
  horizontalSplit?: number;
  verticalSplit?: number;
  quadrants: Record<
    EditorQuadrantId,
    { tabCount: number; activeTabId: string | null; activeTabType: string | null }
  >;
  focusComposerSignals?: Record<EditorQuadrantId, number>;
  globalActiveView?: string;
  urlView?: string | null;
};

export function snapshotEditorGridState(args: {
  editorGroups: EditorGroupsState;
  horizontalSplit: number;
  verticalSplit: number;
  focusComposerSignals: Record<EditorQuadrantId, number>;
  globalActiveView?: string;
}): EditorGridStateSnapshot {
  const { editorGroups, horizontalSplit, verticalSplit, focusComposerSignals, globalActiveView } = args;
  const quadrants = {} as EditorGridStateSnapshot["quadrants"];
  for (const id of QUADRANTS) {
    const g = editorGroups.groups[id];
    const active = g.tabs.find((t) => t.id === g.activeTabId);
    quadrants[id] = {
      tabCount: g.tabs.length,
      activeTabId: g.activeTabId,
      activeTabType: active?.type ?? null,
    };
  }

  let urlView: string | null = null;
  try {
    urlView = new URLSearchParams(window.location.search).get("view");
  } catch {
    urlView = null;
  }

  return {
    layout: editorGroups.layout,
    splitMode: editorGroups.splitMode,
    activeGroupId: editorGroups.activeGroupId,
    gridLeftColumnSpansRows: gridLeftColumnSpansRows(editorGroups.groups),
    gridVisualVariant: resolveEditorGridVisualVariant(editorGroups.layout),
    editorChromeQuadrants: quadrantsWithEditorChrome(editorGroups.layout),
    horizontalSplit,
    verticalSplit,
    quadrants,
    focusComposerSignals: { ...focusComposerSignals },
    globalActiveView,
    urlView,
  };
}

/** Always ships with issue report (`force: true`). */
export function logEditorGridStateChange(
  reason: string,
  snapshot: EditorGridStateSnapshot,
  worktreeId?: string | null,
) {
  logWorkspaceUiIssueReportSignal(
    "editorGrid.state",
    { reason, ...snapshot },
    { worktreeId: worktreeId ?? null },
  );
}

export function logEditorGridFocusAttempt(
  kind: "composerShortcut" | "focusGroup" | "selectGroupTab" | "paneClick",
  payload: Record<string, unknown>,
  worktreeId?: string | null,
) {
  logWorkspaceUiIssueReportSignal(
    "editorGrid.focus",
    { kind, ...payload },
    { worktreeId: worktreeId ?? null },
  );
}

export function probeEditorGridDom(worktreeId?: string | null) {
  const header = document.querySelector('[data-testid="editor-tab-header"]');
  const headerLayout = header?.getAttribute("data-layout") ?? null;
  const splitHost = document.querySelector('[data-testid="split-tab-strips-host"]');
  const hostClass = splitHost?.className ?? null;

  const stripRects: Record<string, ReturnType<typeof rectOf>> = {};
  for (const id of QUADRANTS) {
    stripRects[id] = rectOf(`[data-testid="editor-tab-bar-${id}"]`);
  }

  const gridBody = document.querySelector(
    '[data-testid="editor-grid-l-shape"], [data-testid="editor-grid-r-shape"], [data-testid="editor-grid-full"]',
  );
  const activeEl = document.activeElement;
  const activeTag = activeEl?.tagName ?? null;
  const activeTestId = activeEl instanceof HTMLElement ? activeEl.dataset.testid ?? null : null;

  logWorkspaceUiIssueReportSignal(
    "editorGrid.domProbe",
    {
      headerLayout,
      splitHostClass: hostClass,
      gridBodyTestId: gridBody?.getAttribute("data-testid") ?? null,
      rects: {
        header: rectOf('[data-testid="editor-tab-header"]'),
        splitHost: rectOf('[data-testid="split-tab-strips-host"]'),
        gridL: rectOf('[data-testid="editor-grid-l-shape"]'),
        gridFull: rectOf('[data-testid="editor-grid-full"]'),
        strips: stripRects,
      },
      focus: {
        activeTag,
        activeTestId,
        hasComposerTextarea: !!document.querySelector('[data-testid="composer-textarea"]:focus'),
        hasTerminalInput: !!document.querySelector(".xterm-helper-textarea:focus"),
      },
    },
    { worktreeId: worktreeId ?? null },
  );
}

export function scheduleEditorGridDomProbe(worktreeId?: string | null, delayMs = 100) {
  if (typeof window === "undefined") return;
  window.setTimeout(() => probeEditorGridDom(worktreeId), delayMs);
}