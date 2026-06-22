import { FileCode2, GitPullRequest, MessageSquare, TerminalSquare } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MOBILE_OVERLAY_Z_CLASS } from "../../lib/mobileStacking";
import { cn } from "../../lib/utils";
import type { SessionSwitcherItem, SessionSwitcherItemKind } from "../../pages/workspace/sessionSwitcherItems";

const ICON_BY_KIND: Record<SessionSwitcherItemKind, LucideIcon> = {
  thread: MessageSquare,
  terminal: TerminalSquare,
  review: GitPullRequest,
  file: FileCode2,
};

export function SessionSwitcherOverlay({
  open,
  items,
  selectedIndex,
}: {
  open: boolean;
  items: SessionSwitcherItem[];
  selectedIndex: number;
}) {
  if (!open || items.length === 0) {
    return null;
  }

  return (
    <div className={cn("fixed inset-0 flex items-start justify-center px-4 pt-[14vh]", MOBILE_OVERLAY_Z_CLASS)}>
      <div
        className="w-full max-w-[720px] overflow-hidden rounded-xl border border-border/70 bg-popover/95 shadow-2xl backdrop-blur-[2px]"
        role="listbox"
        aria-label="Switch session tab"
      >
        <div className="max-h-[420px] overflow-y-auto py-1" data-testid="session-switcher">
          {items.map((item, index) => {
            const selected = index === selectedIndex;
            const Icon = ICON_BY_KIND[item.kind];

            return (
              <div
                key={item.key}
                role="option"
                aria-selected={selected}
                className={cn(
                  "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors",
                  selected ? "bg-secondary/70 text-foreground" : "text-foreground/90",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-primary/80" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{item.label}</div>
                  {item.sublabel ? (
                    <div className="truncate text-[11px] text-muted-foreground">{item.sublabel}</div>
                  ) : null}
                </div>
                {item.contextLabel ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {item.contextLabel}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
