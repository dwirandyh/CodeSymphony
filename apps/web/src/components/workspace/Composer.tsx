import { Lightbulb, Send, Zap } from "lucide-react";
import type { ChatMode } from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type ComposerProps = {
  value: string;
  disabled: boolean;
  sending: boolean;
  mode: ChatMode;
  onChange: (nextValue: string) => void;
  onModeChange: (mode: ChatMode) => void;
  onSubmit: () => void;
};

export function Composer({ value, disabled, sending, mode, onChange, onModeChange, onSubmit }: ComposerProps) {
  const cannotSend = disabled || value.trim().length === 0;
  const isPlan = mode === "plan";

  return (
    <section className="pb-2 pt-1">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative rounded-3xl border border-input/50 bg-background/20 px-4 pb-12 pt-3">
          <Textarea
            value={value}
            placeholder={isPlan ? "Describe what you want to plan..." : "Message CodeSymphony..."}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key === "Tab" && event.shiftKey) {
                event.preventDefault();
                onModeChange(isPlan ? "default" : "plan");
                return;
              }

              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                return;
              }

              event.preventDefault();
              if (!cannotSend) {
                onSubmit();
              }
            }}
            className="min-h-[74px] resize-none border-none bg-transparent p-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />

          <div className="absolute bottom-3 left-3 flex items-center">
            <button
              type="button"
              onClick={() => onModeChange(isPlan ? "default" : "plan")}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                isPlan
                  ? "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
              }`}
              aria-label={isPlan ? "Switch to execute mode" : "Switch to plan mode"}
            >
              {isPlan ? <Lightbulb className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              {isPlan ? "Plan" : "Execute"}
            </button>
            <kbd className="ml-1.5 hidden text-[10px] text-muted-foreground/50 sm:inline">Shift+Tab</kbd>
          </div>

          <Button
            type="button"
            onClick={onSubmit}
            disabled={cannotSend}
            size="icon"
            aria-label="Send message"
            className="absolute bottom-3 right-3 h-8 w-8 rounded-full"
          >
            <Send className="h-3.5 w-3.5" />
            <span className="sr-only">{sending ? "Running..." : "Send message"}</span>
          </Button>
        </div>
      </div>
    </section>
  );
}
