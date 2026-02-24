import { useEffect, useRef } from "react";
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
}

export function ScriptOutputTab({ entries, onRerunSetup, rerunning }: ScriptOutputTabProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const latestOutputLength = entries[entries.length - 1]?.output.length ?? 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length, latestOutputLength]);

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

      {entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          No script output yet.
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <pre className="whitespace-pre-wrap break-all p-2 font-mono text-[11px] text-muted-foreground">
            {entries.map((entry) => entry.output).join("")}
          </pre>
          <div ref={bottomRef} />
        </ScrollArea>
      )}
    </div>
  );
}
