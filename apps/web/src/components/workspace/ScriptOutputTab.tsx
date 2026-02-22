import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Play, XCircle } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";

export interface ScriptOutputEntry {
  id: string;
  worktreeId: string;
  worktreeName: string;
  type: "setup" | "teardown";
  timestamp: number;
  output: string;
  success: boolean;
  status: "running" | "completed";
}

interface ScriptOutputTabProps {
  entries: ScriptOutputEntry[];
  onRerunSetup?: () => void;
  rerunning?: boolean;
}

export function ScriptOutputTab({ entries, onRerunSetup, rerunning }: ScriptOutputTabProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      {onRerunSetup && (
        <div className="flex items-center gap-2 border-b border-border/20 px-2 py-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            disabled={rerunning}
            onClick={onRerunSetup}
          >
            {rerunning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            Re-run setup
          </Button>
        </div>
      )}

      {/* Entries */}
      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          No script output yet.
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="space-y-1 p-2 font-mono text-xs">
            {entries.map((entry) => {
              const isCollapsed = collapsedIds.has(entry.id);
              const isRunning = entry.status === "running";

              return (
                <div key={entry.id} className="rounded border border-border/20 bg-background/30">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                    onClick={() => toggleCollapse(entry.id)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    {isRunning ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-400" />
                    ) : entry.success ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    )}
                    <span className="font-semibold text-foreground">
                      {entry.worktreeName}
                    </span>
                    <span className="text-muted-foreground">
                      {entry.type}
                    </span>
                    {isRunning && (
                      <span className="text-[10px] text-blue-400">running...</span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="px-2 pb-2">
                      {entry.output ? (
                        <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded bg-black/20 px-2 py-1 text-[11px] text-muted-foreground">
                          {entry.output}
                        </pre>
                      ) : isRunning ? (
                        <div className="text-[11px] text-muted-foreground/60">Waiting for output...</div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground/60">No output.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
