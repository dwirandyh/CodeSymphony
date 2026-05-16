import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, MessageSquarePlus, Plus, SquareTerminal } from "lucide-react";
import { cn } from "../../lib/utils";

export type SessionCreateAction = "thread" | "terminal";

const PREFERRED_ACTION_STORAGE_KEY = "codesymphony:preferred-session-create-action";

type ActionMeta = {
  icon: typeof MessageSquarePlus;
  label: string;
  title: string;
};

const ACTION_META: Record<SessionCreateAction, ActionMeta> = {
  thread: {
    icon: MessageSquarePlus,
    label: "Thread",
    title: "New thread",
  },
  terminal: {
    icon: SquareTerminal,
    label: "Terminal",
    title: "New terminal",
  },
};

function isSessionCreateAction(value: string | null): value is SessionCreateAction {
  return value === "thread" || value === "terminal";
}

function getPreferredAction(scopeKey?: string | null): SessionCreateAction {
  try {
    if (scopeKey) {
      const scoped = window.localStorage.getItem(`${PREFERRED_ACTION_STORAGE_KEY}:${scopeKey}`);
      if (isSessionCreateAction(scoped)) {
        return scoped;
      }
    }

    const globalAction = window.localStorage.getItem(PREFERRED_ACTION_STORAGE_KEY);
    return isSessionCreateAction(globalAction) ? globalAction : "thread";
  } catch {
    return "thread";
  }
}

function setPreferredAction(scopeKey: string | null | undefined, action: SessionCreateAction): void {
  try {
    if (scopeKey) {
      window.localStorage.setItem(`${PREFERRED_ACTION_STORAGE_KEY}:${scopeKey}`, action);
    }
    window.localStorage.setItem(PREFERRED_ACTION_STORAGE_KEY, action);
  } catch {
    // localStorage not available
  }
}

interface CreateSessionButtonProps {
  preferenceScopeKey?: string | null;
  threadDisabled?: boolean;
  terminalDisabled?: boolean;
  className?: string;
  onCreateThread: () => void;
  onCreateTerminal: () => void;
}

export function CreateSessionButton({
  preferenceScopeKey,
  threadDisabled = false,
  terminalDisabled = false,
  className,
  onCreateThread,
  onCreateTerminal,
}: CreateSessionButtonProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [preferredAction, setPreferredActionState] = useState<SessionCreateAction>(() => getPreferredAction(preferenceScopeKey));
  const preferredActionMeta = ACTION_META[preferredAction];

  useEffect(() => {
    setPreferredActionState(getPreferredAction(preferenceScopeKey));
  }, [preferenceScopeKey]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const menuDisabled = threadDisabled && terminalDisabled;
  const mainActionDisabled = preferredAction === "thread" ? threadDisabled : terminalDisabled;

  function updatePreferredAction(action: SessionCreateAction): void {
    setPreferredActionState(action);
    setPreferredAction(preferenceScopeKey, action);
  }

  function invokeAction(action: SessionCreateAction): void {
    updatePreferredAction(action);
    setMenuOpen(false);

    if (action === "thread") {
      if (!threadDisabled) {
        onCreateThread();
      }
      return;
    }

    if (!terminalDisabled) {
      onCreateTerminal();
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative inline-flex h-7 shrink-0 items-center rounded-md bg-secondary text-secondary-foreground shadow-sm",
        className,
      )}
      data-testid="create-session-button"
    >
      <button
        type="button"
        aria-label="Add session"
        title={`${preferredActionMeta.title} (default)`}
        disabled={mainActionDisabled}
        data-preferred-action={preferredAction}
        className="flex h-full items-center justify-center rounded-l-md px-2 text-secondary-foreground/90 transition-colors hover:bg-black/5 hover:text-secondary-foreground disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/8"
        onClick={() => invokeAction(preferredAction)}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
      </button>

      <div className="h-4 w-px bg-black/10 dark:bg-white/10" />

      <button
        type="button"
        aria-label="Choose session type"
        title="Choose session type"
        aria-expanded={menuOpen}
        disabled={menuDisabled}
        className="flex h-full items-center justify-center rounded-r-md px-1.5 text-secondary-foreground/70 transition-colors hover:bg-black/5 hover:text-secondary-foreground disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/8"
        onClick={() => setMenuOpen((current) => !current)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-[90] mt-2 w-[190px] rounded-lg border border-border/60 bg-popover/95 p-1.5 text-popover-foreground shadow-[0_14px_36px_rgba(15,23,42,0.16)]"
        >
          <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/85">
            Create
          </div>
          <div className="space-y-0.5">
            {(["thread", "terminal"] as SessionCreateAction[]).map((action) => {
              const meta = ACTION_META[action];
              const Icon = meta.icon;
              const disabled = action === "thread" ? threadDisabled : terminalDisabled;
              const selected = action === preferredAction;

              return (
                <button
                  key={action}
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                    selected
                      ? "bg-secondary/70 text-foreground"
                      : "text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                  onClick={() => invokeAction(action)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate">{meta.label}</span>
                  {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-foreground/75" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
