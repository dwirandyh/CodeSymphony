import { useEffect, useMemo, useState } from "react";
import type {
  ApprovePlanInput,
  ChatThreadKind,
  CursorModelCatalogEntry,
  ModelProvider,
  OpencodeModelCatalogEntry,
} from "@codesymphony/shared-types";
import { shouldHandoffApprovedPlanExecution } from "@codesymphony/shared-types";
import { Lightbulb } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import {
  AgentModelSelector,
  type AgentModelSelection,
  buildAgentSelectionOptions,
  findAgentSelectionOption,
  flattenAgentSelectionOptions,
} from "./composer/AgentModelSelector";

type PlanDecisionComposerProps = {
  busy: boolean;
  currentSelection: ApprovePlanInput;
  threadKind: ChatThreadKind | null;
  hasMessages: boolean;
  providers: ModelProvider[];
  cursorModels: CursorModelCatalogEntry[];
  opencodeModels: OpencodeModelCatalogEntry[];
  onApprove: (selection: ApprovePlanInput) => void;
  onRevise: (feedback: string) => void;
};

type DecisionMode = "accept" | "revise";

function normalizeSelection(selection: ApprovePlanInput): AgentModelSelection {
  return {
    agent: selection.agent,
    model: selection.model,
    modelProviderId: selection.modelProviderId ?? null,
  };
}

export function PlanDecisionComposer({
  busy,
  currentSelection,
  threadKind,
  hasMessages,
  providers,
  cursorModels,
  opencodeModels,
  onApprove,
  onRevise,
}: PlanDecisionComposerProps) {
  const [mode, setMode] = useState<DecisionMode>("accept");
  const [feedback, setFeedback] = useState("");
  const normalizedCurrentSelection = normalizeSelection(currentSelection);
  const [selection, setSelection] = useState<AgentModelSelection>(normalizedCurrentSelection);

  useEffect(() => {
    setSelection(normalizeSelection(currentSelection));
  }, [currentSelection.agent, currentSelection.model, currentSelection.modelProviderId]);

  const agentOptions = useMemo(() => buildAgentSelectionOptions({
    providers,
    cursorModels,
    opencodeModels,
  }), [cursorModels, opencodeModels, providers]);

  useEffect(() => {
    if (findAgentSelectionOption(agentOptions, selection)) {
      return;
    }

    const fallbackOption = flattenAgentSelectionOptions(agentOptions)[0];
    if (!fallbackOption) {
      return;
    }

    setSelection({
      agent: fallbackOption.agent,
      model: fallbackOption.model,
      modelProviderId: fallbackOption.modelProviderId,
    });
  }, [agentOptions, selection]);

  const canSubmitRevision = feedback.trim().length > 0;
  const currentProvider = useMemo(() => {
    const providerId = currentSelection.modelProviderId ?? null;
    if (!providerId) {
      return null;
    }

    return providers.find((provider) => provider.id === providerId) ?? null;
  }, [currentSelection.modelProviderId, providers]);
  const selectionChanged = selection.agent !== normalizedCurrentSelection.agent
    || selection.model !== normalizedCurrentSelection.model
    || selection.modelProviderId !== normalizedCurrentSelection.modelProviderId;
  const handoffRequired = selectionChanged && shouldHandoffApprovedPlanExecution({
    messageCount: hasMessages ? 1 : 0,
    threadKind: threadKind ?? "default",
    sourceAgent: currentSelection.agent,
    sourceModelProviderId: currentSelection.modelProviderId ?? null,
    sourceProviderHasBaseUrl: currentSelection.agent === "claude" && Boolean(currentProvider?.baseUrl?.trim()),
    targetAgent: selection.agent,
    targetModelProviderId: selection.modelProviderId ?? null,
  });

  function handleApprove(executionKind: NonNullable<ApprovePlanInput["executionKind"]>) {
    if (busy) {
      return;
    }

    onApprove({
      ...selection,
      executionKind,
    });
  }

  function handleSubmitRevision() {
    if (busy || !canSubmitRevision) {
      return;
    }

    onRevise(feedback.trim());
  }

  return (
    <section className="pb-2 pt-1" data-testid="plan-decision-composer-container">
      <div className="mx-auto w-full max-w-3xl">
        <section className="rounded-lg border border-amber-500/30 bg-background/20 px-3 py-2.5 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 shrink-0 text-amber-400" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-400">Plan requires decision</p>
            </div>
            <span className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-amber-400">
              Pending
            </span>
          </div>

          <p className="mt-2 text-left text-sm text-foreground/90">Implement this plan?</p>

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
                    if (event.key === "Enter" && canSubmitRevision) {
                      event.preventDefault();
                      handleSubmitRevision();
                    }
                  }}
                />
              </div>
            </section>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
            {mode === "accept" ? (
              <AgentModelSelector
                disabled={busy}
                selection={selection}
                providers={providers}
                cursorModels={cursorModels}
                opencodeModels={opencodeModels}
                showAgentList={true}
                ariaLabel="Select plan execution target"
                onSelectionChange={(nextSelection) => setSelection(nextSelection)}
              />
            ) : null}
            {mode === "accept" ? (
              handoffRequired ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label="Handover plan"
                  onClick={() => handleApprove("handoff")}
                >
                  Handover
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    aria-label="Implement plan"
                    onClick={() => handleApprove("same_thread_switch")}
                  >
                    Implement
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label="Handover plan"
                    onClick={() => handleApprove("handoff")}
                  >
                    Handover
                  </Button>
                </>
              )
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busy || !canSubmitRevision}
                aria-label="Submit plan revision"
                onClick={handleSubmitRevision}
              >
                Submit revision
              </Button>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
