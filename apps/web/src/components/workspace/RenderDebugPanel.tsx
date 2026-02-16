import { useEffect, useMemo, useState } from "react";
import {
  clearRenderDebugEntries,
  copyRenderDebugLog,
  getRenderDebugEntries,
  isRenderDebugEnabled,
  subscribeRenderDebug,
  type RenderDebugEntry,
} from "../../lib/renderDebug";

const MAX_VISIBLE_ENTRIES = 120;

function formatTimestamp(input: string): string {
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) {
    return input;
  }

  return new Date(parsed).toLocaleTimeString();
}

export function RenderDebugPanel() {
  const enabled = isRenderDebugEnabled();
  const [entries, setEntries] = useState<RenderDebugEntry[]>(() => getRenderDebugEntries());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    return subscribeRenderDebug((nextEntries) => {
      setEntries(nextEntries);
    });
  }, [enabled]);

  const visibleEntries = useMemo(() => entries.slice(-MAX_VISIBLE_ENTRIES), [entries]);

  if (!enabled) {
    return null;
  }

  return (
    <section
      className="mx-auto mt-2 w-full max-w-3xl rounded-xl border border-border/40 bg-background/20 p-3"
      data-testid="render-debug-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Instrumentation</h3>
          <p className="text-xs text-muted-foreground">
            Stream + activity mapping logs ({entries.length} entries, showing last {visibleEntries.length})
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border/50 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              clearRenderDebugEntries();
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className="rounded-md border border-border/50 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              void copyRenderDebugLog().then((ok) => {
                if (!ok) {
                  return;
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 1000);
              });
            }}
          >
            {copied ? "Copied" : "Copy JSON"}
          </button>
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto rounded-md border border-border/35 bg-secondary/15 p-2">
        {visibleEntries.length === 0 ? (
          <div className="px-1 py-2 text-xs text-muted-foreground">No instrumentation events yet.</div>
        ) : (
          <div className="space-y-1.5">
            {visibleEntries.map((entry, index) => (
              <details key={`${entry.ts}-${entry.source}-${entry.event}-${index}`} className="rounded-md border border-border/25 px-2 py-1 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  [{formatTimestamp(entry.ts)}] {entry.source}.{entry.event}
                  {entry.messageId ? ` (${entry.messageId})` : ""}
                </summary>
                {entry.details ? (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                ) : null}
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
