import type { ChatEvent } from "@codesymphony/shared-types";
import { ScrollArea } from "../ui/scroll-area";

type ToolLogsPanelProps = {
  toolEvents: ChatEvent[];
};

export function ToolLogsPanel({ toolEvents }: ToolLogsPanelProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="px-1 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Checks</h3>
      </div>

      <div className="min-h-0 flex-1 px-1 pb-1">
        <ScrollArea className="h-full" data-testid="logs-scroll">
          {toolEvents.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No tool activity yet.</div>
          ) : (
            <div className="space-y-2">
              {toolEvents.map((event) => (
                <details key={event.id} className="border-l border-border/50 pl-2 text-xs" open={event.type === "chat.failed"}>
                  <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-foreground">
                    <span className="text-[10px] text-muted-foreground">#{event.idx}</span>
                    <span>{event.type}</span>
                  </summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </section>
  );
}
