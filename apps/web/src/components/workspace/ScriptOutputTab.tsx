import { useEffect, useMemo, useRef } from "react";
import { Loader2, Play } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";

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
  showHeader?: boolean;
}

export function ScriptOutputTab({
  entries,
  onRerunSetup,
  rerunning,
  showHeader = true,
}: ScriptOutputTabProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

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
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [setupEntries.length, latestSetupOutputLength]);

  return (
    <div className={showHeader ? "flex h-full flex-col overflow-auto p-2" : "flex h-full flex-col overflow-auto p-3 pt-2"}>
      {showHeader ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-foreground">Setup Script</div>
            <div className="text-[10px] text-muted-foreground">Runs automatically after worktree creation.</div>
          </div>

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
      ) : null}

      <div className="overflow-hidden rounded-md border border-border/20 bg-card/30">
        {setupEntries.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">No setup output yet.</div>
        ) : (
          <ScrollArea className="max-h-full">
            <pre className="whitespace-pre-wrap break-all p-2 font-mono text-[11px] text-muted-foreground">
              {setupOutput}
            </pre>
            <div ref={bottomRef} />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
