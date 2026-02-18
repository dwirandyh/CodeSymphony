import { useCallback, useEffect, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { TerminalTab } from "./TerminalTab";
import { DebugConsoleTab } from "./DebugConsoleTab";

const MIN_HEIGHT = 120;
const MAX_HEIGHT_RATIO = 0.6;
const DEFAULT_HEIGHT = 250;

interface BottomPanelProps {
    worktreeId: string | null;
    worktreePath: string | null;
}

export function BottomPanel({ worktreeId, worktreePath }: BottomPanelProps) {
    const [height, setHeight] = useState(DEFAULT_HEIGHT);
    const [collapsed, setCollapsed] = useState(false);
    const [activeTab, setActiveTab] = useState("terminal");
    const [isDragging, setIsDragging] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const startYRef = useRef(0);
    const startHeightRef = useRef(0);

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            setIsDragging(true);
            startYRef.current = e.clientY;
            startHeightRef.current = height;
        },
        [height],
    );

    useEffect(() => {
        if (!isDragging) {
            return;
        }

        function handleMouseMove(e: MouseEvent) {
            const delta = startYRef.current - e.clientY;
            const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
            const newHeight = Math.min(
                maxHeight,
                Math.max(MIN_HEIGHT, startHeightRef.current + delta),
            );
            setHeight(newHeight);
        }

        function handleMouseUp() {
            setIsDragging(false);
        }

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);

        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
        };
    }, [isDragging]);

    return (
        <div className="-mx-2.5 flex flex-col border-t border-border/30 bg-[hsl(220,18%,10%)] lg:-mx-3">
            <Tabs.Root
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex min-h-0 flex-1 flex-col"
            >
                {/* Tab header — always visible in both collapsed and expanded states */}
                <div className="flex items-center border-b border-border/20 px-1">
                    <Tabs.List className="flex items-center">
                        <Tabs.Trigger
                            value="terminal"
                            className="relative px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground"
                        >
                            Terminal
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </Tabs.Trigger>
                        <Tabs.Trigger
                            value="debug"
                            className="relative px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:text-foreground"
                        >
                            Debug Console
                            <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t-full bg-primary opacity-0 transition-opacity data-[state=active]:opacity-100" />
                        </Tabs.Trigger>
                    </Tabs.List>

                    <div className="flex-1" />

                    {/* Toggle collapse/expand button */}
                    <button
                        type="button"
                        className="mr-1 rounded p-1 text-muted-foreground/50 transition-colors hover:bg-secondary/40 hover:text-foreground"
                        onClick={() => setCollapsed((prev) => !prev)}
                        title={collapsed ? "Expand panel" : "Collapse panel"}
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                            className={`transition-transform ${collapsed ? "rotate-180" : ""}`}
                        >
                            <path
                                d="M3 4.5L6 7.5L9 4.5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </button>
                </div>

                {/* Panel body — hidden via CSS when collapsed so children stay mounted */}
                <div
                    ref={panelRef}
                    className={`flex flex-col ${collapsed ? "invisible h-0 overflow-hidden" : ""}`}
                    style={collapsed ? undefined : { height: `${height}px` }}
                >
                    {/* Resize handle */}
                    <div
                        className={`group flex h-1 cursor-row-resize items-center justify-center transition-colors hover:bg-primary/20 ${isDragging ? "bg-primary/30" : ""
                            }`}
                        onMouseDown={handleMouseDown}
                    >
                        <div
                            className={`h-[2px] w-10 rounded-full transition-colors ${isDragging
                                    ? "bg-primary/60"
                                    : "bg-border/30 group-hover:bg-primary/40"
                                }`}
                        />
                    </div>

                    <Tabs.Content value="terminal" className="min-h-0 flex-1 data-[state=inactive]:hidden">
                        <TerminalTab sessionId={worktreeId ?? "default"} cwd={worktreePath} />
                    </Tabs.Content>

                    <Tabs.Content value="debug" className="min-h-0 flex-1 data-[state=inactive]:hidden">
                        <DebugConsoleTab />
                    </Tabs.Content>
                </div>
            </Tabs.Root>
        </div>
    );
}
