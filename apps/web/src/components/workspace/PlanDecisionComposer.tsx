import { useMemo, useState } from "react";
import { Lightbulb } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

type PlanDecisionComposerProps = {
  busy: boolean;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
};

type DecisionMode = "accept" | "revise";

export function PlanDecisionComposer({ busy, onApprove, onRevise }: PlanDecisionComposerProps) {
  const [mode, setMode] = useState<DecisionMode>("accept");
  const [feedback, setFeedback] = useState("");

  const canSubmit = useMemo(() => {
    if (busy) {
      return false;
    }

    if (mode === "accept") {
      return true;
    }

    return feedback.trim().length > 0;
  }, [busy, feedback, mode]);

  function resetRevision() {
    setMode("accept");
    setFeedback("");
  }

  function handleSubmit() {
    if (!canSubmit) {
      return;
    }

    if (mode === "accept") {
      onApprove();
      return;
    }

    onRevise(feedback.trim());
  }

  return (
    <section className="pb-2 pt-1" data-testid="plan-decision-composer-container">
      <div className="mx-auto w-full max-w-3xl">
        <section className="rounded-lg border border-amber-500/30 bg-background/20 px-3 py-3 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 shrink-0 text-amber-400" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-400">Plan requires decision</p>
            </div>
            <span className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-amber-400">
              Pending
            </span>
          </div>

          <p className="mt-3 text-left text-sm text-foreground/90">Implement this plan?</p>

          <div className="mt-2 space-y-1.5" role="radiogroup" aria-label="Plan decision">
            <div
              aria-label="Choose accept plan"
              aria-checked={mode === "accept"}
              role="radio"
              tabIndex={busy ? -1 : 0}
              onClick={() => setMode("accept")}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && !busy) {
                  event.preventDefault();
                  setMode("accept");
                }
              }}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left text-xs transition-colors",
                busy ? "opacity-60" : "",
                mode === "accept"
                  ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                  : "border-border/35 bg-background/35 text-muted-foreground hover:border-border/60 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                  mode === "accept" ? "border-amber-400 bg-amber-500/30" : "border-muted-foreground/40 bg-transparent",
                )}
              >
                {mode === "accept" ? <span className="h-1.5 w-1.5 rounded-full bg-amber-300" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Yes, implement this plan</span>
              </span>
            </div>

            <section
              aria-label="Choose revise plan"
              data-testid="plan-revise-option"
              role="radio"
              aria-checked={mode === "revise"}
              tabIndex={busy ? -1 : 0}
              onClick={() => setMode("revise")}
              onKeyDown={(event) => {
                if (event.target instanceof HTMLInputElement) return;
                if ((event.key === "Enter" || event.key === " ") && !busy) {
                  event.preventDefault();
                  setMode("revise");
                }
              }}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-xs transition-colors",
                busy ? "opacity-60" : "",
                mode === "revise"
                  ? "border-amber-500/50 bg-amber-500/15 text-amber-300"
                  : "border-border/35 bg-background/35 text-muted-foreground hover:border-border/60 hover:text-foreground",
              )}
            >
              <div className="flex w-full items-center gap-2.5 text-left">
                <span
                  className={cn(
                    "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    mode === "revise" ? "border-amber-400 bg-amber-500/30" : "border-muted-foreground/40 bg-transparent",
                  )}
                >
                  {mode === "revise" ? <span className="h-1.5 w-1.5 rounded-full bg-amber-300" /> : null}
                </span>
                <input
                  type="text"
                  aria-label="Plan revision feedback"
                  value={feedback}
                  onFocus={() => setMode("revise")}
                  onChange={(event) => {
                    setMode("revise");
                    setFeedback(event.target.value);
                  }}
                  disabled={busy}
                  placeholder="Revise this plan"
                  className={cn(
                    "h-5 w-full border-0 bg-transparent p-0 text-xs font-medium shadow-none outline-none ring-0",
                    "placeholder:text-current/80 focus:outline-none",
                    mode === "revise" ? "text-amber-300" : "text-muted-foreground",
                  )}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canSubmit) {
                      event.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
              </div>
            </section>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label="Dismiss plan decision"
              onClick={resetRevision}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSubmit}
              aria-label={mode === "accept" ? "Submit plan acceptance" : "Submit plan revision"}
              onClick={handleSubmit}
            >
              {mode === "accept" ? "Submit" : "Submit revision"}
            </Button>
          </div>
        </section>
      </div>
    </section>
  );
}
