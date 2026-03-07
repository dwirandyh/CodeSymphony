import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { DebugConsoleTab } from "./DebugConsoleTab";
import { ScriptOutputTab, type ScriptOutputEntry } from "./ScriptOutputTab";

const TerminalTab = lazy(() =>
    import("./TerminalTab").then(m => ({ default: m.TerminalTab }))
);

const MIN_HEIGHT = 120;
const MAX_HEIGHT_RATIO = 0.6;
const DEFAULT_HEIGHT = 250;

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
    onTabChange: (tab: string) => void;
    onRerunSetup?: () => void;
    runScriptActive: boolean;
    onRunScriptExit?: (event: { exitCode: number; signal: number }) => void;
    openSignal?: number;
}

export function BottomPanel({
    worktreeId,
    worktreePath,
    selectedThreadId,
    scriptOutputs,
    activeTab,
    onTabChange,
    onRerunSetup,
    runScriptActive,
    onRunScriptExit,
    openSignal,
}: BottomPanelProps) {
    const [height, setHeight] = useState(DEFAULT_HEIGHT);
    const [collapsed, setCollapsed] = useState(true);
    const [isDragging, setIsDragging] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const startYRef = useRef(0);
    const startHeightRef = useRef(0);
    const prevOpenSignalRef = useRef<number | undefined>(openSignal);

    const filteredOutputs = useMemo(
        () => worktreeId ? scriptOutputs.filter((e) => e.worktreeId === worktreeId) : [],
        [scriptOutputs, worktreeId],
    );
    const scriptRunnerSessionId = useMemo(
        () => (worktreeId && runScriptActive ? `${worktreeId}:script-runner` : null),
        [worktreeId, runScriptActive],
    );

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            setIsDragging(true);
            startYRef.current = e.clientY;
            startHeightRef.current = height;
        },
        [height],
    );

    const handleTouchStart = useCallback(
        (e: React.TouchEvent) => {
            setIsDragging(true);
            startYRef.current = e.touches[0].clientY;
            startHeightRef.current = height;
        },
        [height],
    );

    useEffect(() => {
        if (!isDragging) {
            return;
        }

        function handleMove(e: MouseEvent | TouchEvent) {
            const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
            const delta = startYRef.current - clientY;
            const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
            const newHeight = Math.min(
                maxHeight,
                Math.max(MIN_HEIGHT, startHeightRef.current + delta),
            );
            setHeight(newHeight);
        }

        function handleEnd() {
            setIsDragging(false);
        }

        document.addEventListener("mousemove", handleMove);
        document.addEventListener("mouseup", handleEnd);
        document.addEventListener("touchmove", handleMove, { passive: false });
        document.addEventListener("touchend", handleEnd);

        return () => {
            document.removeEventListener("mousemove", handleMove);
            document.removeEventListener("mouseup", handleEnd);
            document.removeEventListener("touchmove", handleMove);
            document.removeEventListener("touchend", handleEnd);
        };
    }, [isDragging]);

    useEffect(() => {
        if (openSignal === undefined) {
            return;
        }
        if (prevOpenSignalRef.current !== openSignal) {
            setCollapsed(false);
            prevOpenSignalRef.current = openSignal;
        }
    }, [openSignal]);

    return (
        <div className="-mx-1.5 flex flex-col border-t border-border/30 bg-[hsl(220,18%,10%)] safe-bottom sm:-mx-2.5 lg:-mx-4">
            <Tabs.Root
                value={activeTab}
                onValueChange={(val) => {
                    onTabChange(val);
                    if (collapsed) setCollapsed(false);
                }}
                className="flex min-h-0 flex-1 flex-col"
            >
                {/* Resize handle — always visible, including collapsed state */}
                <div
                    className={`group flex h-2 cursor-row-resize touch-none items-center justify-center bg-card/75 transition-colors hover:bg-primary/20 md:h-1 ${isDragging ? "bg-primary/30" : ""
                        }`}
                    onMouseDown={handleMouseDown}
                    onTouchStart={handleTouchStart}
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
                    <Tabs.List className="flex items-center">
                        <Tabs.Trigger
                            value="terminal"
                            className="relative px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground md:py-1.5"
                        >
                            Terminal
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </Tabs.Trigger>
                        <Tabs.Trigger
                            value="debug"
                            className="relative px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground md:py-1.5"
                        >
                            Debug Console
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </Tabs.Trigger>
                        <Tabs.Trigger
                            value="output"
                            className="relative px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground md:py-1.5"
                        >
                            Output
                            {filteredOutputs.length > 0 && (
                                <span className="ml-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary/20 px-1 text-[9px] font-bold leading-none text-primary">
                                    {filteredOutputs.length}
                                </span>
                            )}
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </Tabs.Trigger>
                    </Tabs.List>

                    <div className="flex-1" />

                    {/* Toggle collapse/expand button */}
                    <button
                        type="button"
                        className="mr-1 rounded p-2 text-muted-foreground/50 transition-colors hover:bg-secondary/40 hover:text-foreground md:p-1"
                        onClick={() => setCollapsed((prev) => !prev)}
                        title={collapsed ? "Expand panel" : "Collapse panel"}
                    >
                        <span className={`inline-block transition-transform ${collapsed ? "rotate-180" : ""}`}>
                            {collapseIcon}
                        </span>
                    </button>
                </div>

                {/* Panel body — hidden via CSS when collapsed so children stay mounted */}
                <div
                    ref={panelRef}
                    className={`flex flex-col overflow-hidden ${collapsed ? "invisible h-0" : ""}`}
                    style={collapsed ? undefined : { height: `${height}px` }}
                >
                    <Tabs.Content value="terminal" className="min-h-0 flex-1 data-[state=inactive]:hidden">
                        <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading terminal...</div>}>
                            <TerminalTab sessionId={worktreeId && selectedThreadId ? `${worktreeId}:${selectedThreadId}` : worktreeId ?? "default"} cwd={worktreePath} />
                        </Suspense>
                    </Tabs.Content>

                    <Tabs.Content value="debug" className="min-h-0 flex-1 data-[state=inactive]:hidden">
                        <DebugConsoleTab selectedThreadId={selectedThreadId} />
                    </Tabs.Content>

                    <Tabs.Content value="output" className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
                        <ScriptOutputTab
                            entries={filteredOutputs}
                            onRerunSetup={onRerunSetup}
                            rerunning={filteredOutputs.some((e) => e.type !== "run" && e.status === "running")}
                            scriptRunnerSessionId={scriptRunnerSessionId}
                            worktreePath={worktreePath}
                            onRunScriptExit={onRunScriptExit}
                        />
                    </Tabs.Content>
                </div>
            </Tabs.Root>
        </div>
    );
}
