import { AlertTriangle, X } from "lucide-react";
import { createPortal } from "react-dom";
import { MOBILE_OVERLAY_Z_CLASS } from "../../lib/mobileStacking";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export function LiveStatusErrorToast({
  title,
  description,
  mobileComposerPinned = false,
  onDismiss,
}: {
  title: string;
  description: string;
  mobileComposerPinned?: boolean;
  onDismiss: () => void;
}) {
  if (typeof document === "undefined") {
    return null;
  }
  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 flex justify-end px-3 sm:inset-x-auto sm:right-4 sm:px-0",
        MOBILE_OVERLAY_Z_CLASS,
        mobileComposerPinned
          ? "bottom-[calc(0.75rem+var(--cs-mobile-composer-rest-offset,4rem))]"
          : "bottom-3",
      )}
    >
      <section
        aria-live="polite"
        className="pointer-events-auto w-full max-w-sm rounded-2xl border border-destructive/30 bg-background/95 p-4 shadow-2xl backdrop-blur sm:w-[22rem]"
        data-testid="workspace-live-error-toast"
        role="status"
      >
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-destructive/10 p-2 text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>
          <Button
            aria-label="Dismiss live update error"
            className="h-7 w-7 shrink-0"
            onClick={onDismiss}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
