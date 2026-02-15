import { Send } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type ComposerProps = {
  value: string;
  disabled: boolean;
  sending: boolean;
  onChange: (nextValue: string) => void;
  onSubmit: () => void;
};

export function Composer({ value, disabled, sending, onChange, onSubmit }: ComposerProps) {
  const cannotSend = disabled || value.trim().length === 0;

  return (
    <section className="pb-2 pt-1">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative rounded-3xl border border-input/50 bg-background/20 px-4 pb-12 pt-3">
          <Textarea
            value={value}
            placeholder="Message CodeSymphony..."
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            onKeyDown={(event) => {
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
