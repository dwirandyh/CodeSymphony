import { useCallback, useEffect, useRef, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { TerminalTab } from "./TerminalTab";
import { DebugConsoleTab } from "./DebugConsoleTab";

const MIN_HEIGHT = 120;
const MAX_HEIGHT_RATIO = 0.6;
const DEFAULT_HEIGHT = 250;

export function BottomPanel() {
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

    if (collapsed) {
        return (
            <div className="flex items-center border-t border-border/30 bg-[hsl(220,18%,10%)]">
                <button
                    type="button"
                    className="flex items-center gap-1.5 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setCollapsed(false)}
                >
                    <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        className="rotate-180"
                    >
                        <path
                            d="M2 6.5L5 3.5L8 6.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                    Panel
                </button>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
                    <button
                        type="button"
                        className={`px-2 py-1 transition-colors hover:text-foreground ${activeTab === "terminal" ? "text-muted-foreground" : ""
                            }`}
                        onClick={() => {
                            setActiveTab("terminal");
                            setCollapsed(false);
                        }}
                    >
                        Terminal
                    </button>
                    <button
                        type="button"
                        className={`px-2 py-1 transition-colors hover:text-foreground ${activeTab === "debug" ? "text-muted-foreground" : ""
                            }`}
                        onClick={() => {
                            setActiveTab("debug");
                            setCollapsed(false);
                        }}
                    >
                        Debug Console
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={panelRef}
            className="flex flex-col border-t border-border/30 bg-[hsl(220,18%,10%)]"
            style={{ height: `${height}px` }}
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

            {/* Tabs */}
            <Tabs.Root
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex min-h-0 flex-1 flex-col"
            >
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

                    {/* Collapse button */}
                    <button
                        type="button"
                        className="mr-1 rounded p-1 text-muted-foreground/50 transition-colors hover:bg-secondary/40 hover:text-foreground"
                        onClick={() => setCollapsed(true)}
                        title="Collapse panel"
                    >
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
                    </button>
                </div>

                <Tabs.Content value="terminal" className="min-h-0 flex-1 data-[state=inactive]:hidden">
                    <TerminalTab />
                </Tabs.Content>

                <Tabs.Content value="debug" className="min-h-0 flex-1 data-[state=inactive]:hidden">
                    <DebugConsoleTab />
                </Tabs.Content>
            </Tabs.Root>
        </div>
    );
}
