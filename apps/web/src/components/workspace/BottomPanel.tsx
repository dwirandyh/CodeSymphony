import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Root as TabsRoot, List as TabsList, Trigger as TabsTrigger, Content as TabsContent } from "@radix-ui/react-tabs";
import { DebugConsoleTab } from "./DebugConsoleTab";
import { ScriptOutputTab, type ScriptOutputEntry } from "./ScriptOutputTab";

const TerminalTab = lazy(() =>
    import("./TerminalTab").then(m => ({ default: m.TerminalTab }))
);

const MIN_HEIGHT = 120;
const MAX_HEIGHT_RATIO = 0.6;
const DEFAULT_HEIGHT = 250;
const TERMINAL_SURFACE_CLASS = "bg-[#0f1218]";

const collapseIcon = (
    <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
    >
        <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

interface BottomPanelProps {
    worktreeId: string | null;
    worktreePath: string | null;
    selectedThreadId: string | null;
    scriptOutputs: ScriptOutputEntry[];
    activeTab: string;
    collapsed: boolean;
    onTabChange: (tab: string) => void;
    onCollapsedChange: (collapsed: boolean) => void;
    onRerunSetup?: () => void;
    runScriptActive: boolean;
    runScriptSessionId: string | null;
    onRunScriptExit?: (event: { exitCode: number; signal: number }) => void;
    openSignal?: number;
}

type BottomPanelContentProps = Omit<BottomPanelBodyProps, "activeTab" | "collapsed" | "height" | "panelRef">;

type BottomPanelBodyProps = {
    collapsed: boolean;
    height: number;
    panelRef: RefObject<HTMLDivElement | null>;
    activeTab: string;
    setupOutputs: ScriptOutputEntry[];
    onRerunSetup?: () => void;
    runScriptActive: boolean;
    runScriptSessionId: string | null;
    onRunScriptExit?: (event: { exitCode: number; signal: number }) => void;
    worktreeId: string | null;
    worktreePath: string | null;
    selectedThreadId: string | null;
};

const BottomPanelContent = memo(function BottomPanelContent({
    setupOutputs,
    onRerunSetup,
    runScriptActive,
    runScriptSessionId,
    onRunScriptExit,
    worktreeId,
    worktreePath,
    selectedThreadId,
}: BottomPanelContentProps) {
    return (
        <>
            <TabsContent value="setup-script" className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
                <ScriptOutputTab
                    entries={setupOutputs}
                    onRerunSetup={onRerunSetup}
                    rerunning={setupOutputs.some((e) => e.status === "running")}
                />
            </TabsContent>

            <TabsContent value="terminal" className={`mt-0 flex h-full min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden ${TERMINAL_SURFACE_CLASS}`}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading terminal...</div>}>
                    <TerminalTab sessionId={worktreeId ? `${worktreeId}:terminal` : "default"} cwd={worktreePath} />
                </Suspense>
            </TabsContent>

            <TabsContent value="run" className={`mt-0 flex h-full min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden ${TERMINAL_SURFACE_CLASS}`}>
                {runScriptSessionId ? (
                    <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading terminal...</div>}>
                        <TerminalTab
                            sessionId={runScriptSessionId}
                            cwd={worktreePath}
                            onSessionExit={onRunScriptExit}
                        />
                    </Suspense>
                ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        No run session active.
                    </div>
                )}
            </TabsContent>

            <TabsContent value="debug" className="min-h-0 flex-1 data-[state=inactive]:hidden">
                <DebugConsoleTab worktreeId={worktreeId} selectedThreadId={selectedThreadId} />
            </TabsContent>
        </>
    );
});

const BottomPanelBody = memo(function BottomPanelBody({
    activeTab,
    collapsed,
    height,
    panelRef,
    ...contentProps
}: BottomPanelBodyProps) {
    return (
        <div
            ref={panelRef}
            data-testid="bottom-panel-body"
            className={`flex flex-col overflow-hidden ${
                activeTab === "terminal" || activeTab === "run"
                    ? TERMINAL_SURFACE_CLASS
                    : ""
            } ${collapsed ? "invisible h-0" : ""}`}
            style={collapsed ? undefined : { height: `${height}px` }}
        >
            <BottomPanelContent {...contentProps} />
        </div>
    );
});

export const BottomPanel = memo(function BottomPanel({
    worktreeId,
    worktreePath,
    selectedThreadId,
    scriptOutputs,
    activeTab,
    collapsed,
    onTabChange,
    onCollapsedChange,
    onRerunSetup,
    runScriptActive,
    runScriptSessionId,
    onRunScriptExit,
    openSignal,
}: BottomPanelProps) {
    const [height, setHeight] = useState(DEFAULT_HEIGHT);
    const [isDragging, setIsDragging] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const startYRef = useRef(0);
    const startHeightRef = useRef(0);
    const activePointerIdRef = useRef<number | null>(null);
    const prevWorktreeIdRef = useRef<string | null>(worktreeId);
    const prevOpenSignalRef = useRef<number | undefined>(openSignal);

    const filteredOutputs = useMemo(
        () => worktreeId ? scriptOutputs.filter((e) => e.worktreeId === worktreeId) : [],
        [scriptOutputs, worktreeId],
    );
    const setupOutputs = useMemo(
        () => filteredOutputs.filter((entry) => entry.type === "setup" || entry.type === "teardown"),
        [filteredOutputs],
    );
    const latestSetupOutput = setupOutputs[setupOutputs.length - 1] ?? null;
    const showSetupStatusChip = latestSetupOutput !== null;
    const setupStatusChipClassName = latestSetupOutput?.status === "completed" && !latestSetupOutput.success
        ? "bg-destructive/20 text-destructive"
        : "bg-primary/20 text-primary";
    const updateHeightFromClientY = useCallback((clientY: number) => {
        const delta = startYRef.current - clientY;
        const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
        const newHeight = Math.min(
            maxHeight,
            Math.max(MIN_HEIGHT, startHeightRef.current + delta),
        );
        setHeight(newHeight);
    }, []);

    useEffect(() => {
        if (!isDragging) {
            return;
        }

        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;
        const stopDragging = () => {
            activePointerIdRef.current = null;
            setIsDragging(false);
        };

        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("blur", stopDragging);

        return () => {
            window.removeEventListener("blur", stopDragging);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
        };
    }, [isDragging]);

    const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary || event.button !== 0) {
            return;
        }

        event.preventDefault();
        activePointerIdRef.current = event.pointerId;
        startYRef.current = event.clientY;
        startHeightRef.current = height;
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDragging(true);
    }, [height]);

    const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging || activePointerIdRef.current !== event.pointerId) {
            return;
        }

        event.preventDefault();
        updateHeightFromClientY(event.clientY);
    }, [isDragging, updateHeightFromClientY]);

    const handlePointerRelease = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerIdRef.current !== event.pointerId) {
            return;
        }

        activePointerIdRef.current = null;
        setIsDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }, []);

    useEffect(() => {
        if (prevWorktreeIdRef.current !== worktreeId) {
            prevWorktreeIdRef.current = worktreeId;
            prevOpenSignalRef.current = openSignal;
            return;
        }

        if (openSignal === undefined) {
            return;
        }
        if (prevOpenSignalRef.current !== openSignal) {
            onCollapsedChange(false);
            prevOpenSignalRef.current = openSignal;
        }
    }, [onCollapsedChange, openSignal, worktreeId]);

    const currentContentProps = useMemo<BottomPanelContentProps>(() => ({
        setupOutputs,
        onRerunSetup,
        runScriptActive,
        runScriptSessionId,
        onRunScriptExit,
        worktreeId,
        worktreePath,
        selectedThreadId,
    }), [
        onRerunSetup,
        onRunScriptExit,
        runScriptActive,
        runScriptSessionId,
        selectedThreadId,
        setupOutputs,
        worktreeId,
        worktreePath,
    ]);
    const hiddenContentPropsRef = useRef<BottomPanelContentProps>(currentContentProps);
    if (!collapsed) {
        hiddenContentPropsRef.current = currentContentProps;
    }
    const renderedContentProps = collapsed
        ? hiddenContentPropsRef.current
        : currentContentProps;

    return (
        <div
            className={`-mx-1.5 flex flex-col border-t border-border/30 safe-bottom sm:-mx-2.5 lg:-mx-3 ${
                activeTab === "terminal" || activeTab === "run"
                    ? TERMINAL_SURFACE_CLASS
                    : "bg-[hsl(220,18%,10%)]"
            }`}
        >
            <TabsRoot
                value={activeTab}
                onValueChange={(val) => {
                    onTabChange(val);
                    if (collapsed) onCollapsedChange(false);
                }}
                className="flex min-h-0 flex-1 flex-col"
            >
                {/* Resize handle — always visible, including collapsed state */}
                <div
                    data-testid="bottom-panel-resize-handle"
                    role="separator"
                    aria-orientation="horizontal"
                    className={`group flex h-2 cursor-row-resize touch-none items-center justify-center bg-card/75 transition-colors hover:bg-primary/20 md:h-1 ${isDragging ? "bg-primary/30" : ""
                        }`}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerRelease}
                    onPointerCancel={handlePointerRelease}
                    onLostPointerCapture={handlePointerRelease}
                >
                    <div
                        className={`h-[2px] w-10 rounded-full transition-colors ${isDragging
                                ? "bg-primary/60"
                                : "bg-border/30 group-hover:bg-primary/40"
                            }`}
                    />
                </div>

                {/* Tab header — always visible in both collapsed and expanded states */}
                <div className="flex items-center border-b border-border/20 bg-card/75 px-1">
                    <TabsList className="flex items-center">
                        <TabsTrigger
                            value="setup-script"
                            className="relative px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground md:py-1.5"
                        >
                            Setup Script
                            {showSetupStatusChip && (
                                <span
                                    data-testid="setup-script-status-chip"
                                    className={`ml-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none ${setupStatusChipClassName}`}
                                >
                                    •
                                </span>
                            )}
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </TabsTrigger>
                        <TabsTrigger
                            value="terminal"
                            className="relative px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground md:py-1.5"
                        >
                            Terminal
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </TabsTrigger>
                        <TabsTrigger
                            value="run"
                            className="relative px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground md:py-1.5"
                        >
                            Run
                            {runScriptActive && (
                                <span className="ml-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary/20 px-1 text-[9px] font-bold leading-none text-primary">
                                    •
                                </span>
                            )}
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </TabsTrigger>
                        <TabsTrigger
                            value="debug"
                            className="relative px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground md:py-1.5"
                        >
                            Debug Console
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </TabsTrigger>
                    </TabsList>

                    <div className="flex-1" />

                    {/* Toggle collapse/expand button */}
                    <button
                        type="button"
                        className="mr-1 rounded p-2 text-muted-foreground/50 transition-colors hover:bg-secondary/40 hover:text-foreground md:p-1"
                        onClick={() => onCollapsedChange(!collapsed)}
                        title={collapsed ? "Expand panel" : "Collapse panel"}
                    >
                        <span className={`inline-block transition-transform ${collapsed ? "rotate-180" : ""}`}>
                            {collapseIcon}
                        </span>
                    </button>
                </div>

                {/* Panel body — keep the last visible subtree stable while collapsed so hidden heavy panels do not rerender on worktree switches */}
                <BottomPanelBody
                    activeTab={activeTab}
                    collapsed={collapsed}
                    height={height}
                    panelRef={panelRef}
                    {...renderedContentProps}
                />
            </TabsRoot>
        </div>
    );
});
