import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Play } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";

const TerminalTab = lazy(() =>
  import("./TerminalTab").then((m) => ({ default: m.TerminalTab })),
);

export interface ScriptOutputEntry {
  id: string;
  worktreeId: string;
  worktreeName: string;
  type: "setup" | "teardown" | "run";
  timestamp: number;
  output: string;
  success: boolean;
  status: "running" | "completed";
}

interface ScriptOutputTabProps {
  entries: ScriptOutputEntry[];
  onRerunSetup?: () => void;
  rerunning?: boolean;
  scriptRunnerSessionId: string | null;
  worktreePath: string | null;
}

export function ScriptOutputTab({
  entries,
  onRerunSetup,
  rerunning,
  scriptRunnerSessionId,
  worktreePath,
}: ScriptOutputTabProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  const [runCollapsed, setRunCollapsed] = useState(false);

  const setupEntries = useMemo(
    () => entries.filter((entry) => entry.type === "setup" || entry.type === "teardown"),
    [entries],
  );

  const setupOutput = useMemo(
    () => setupEntries.map((entry) => entry.output).join(""),
    [setupEntries],
  );

  const latestSetupOutputLength = setupEntries[setupEntries.length - 1]?.output.length ?? 0;

  useEffect(() => {
    if (setupCollapsed) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [setupEntries.length, latestSetupOutputLength, setupCollapsed]);

  useEffect(() => {
    if (scriptRunnerSessionId) {
      setRunCollapsed(false);
    }
  }, [scriptRunnerSessionId]);

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-2">
      <div className="overflow-hidden rounded-md border border-border/20 bg-card/30">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setSetupCollapsed((prev) => !prev)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {setupCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            )}
            <span className="text-xs font-medium text-foreground">Setup Script</span>
          </button>

          {onRerunSetup && (
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
          )}
        </div>

        {!setupCollapsed && (
          <div className="border-t border-border/10">
            {setupEntries.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">No setup output yet.</div>
            ) : (
              <ScrollArea className={scriptRunnerSessionId ? "max-h-40" : "max-h-[280px]"}>
                <pre className="whitespace-pre-wrap break-all p-2 font-mono text-[11px] text-muted-foreground">
                  {setupOutput}
                </pre>
                <div ref={bottomRef} />
              </ScrollArea>
            )}
          </div>
        )}
      </div>

      {scriptRunnerSessionId && (
        <div className="overflow-hidden rounded-md border border-border/20 bg-card/30">
          <button
            type="button"
            onClick={() => setRunCollapsed((prev) => !prev)}
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
          >
            {runCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            )}
            <span className="text-xs font-medium text-foreground">Run Script</span>
          </button>

          {!runCollapsed && (
            <div className="h-56 border-t border-border/10">
              <Suspense
                fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading terminal...</div>}
              >
                <TerminalTab sessionId={scriptRunnerSessionId} cwd={worktreePath} />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
