import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";

const EDIT_TOOL_REGEX = /^(edit|multiedit|write)$/i;

type PermissionPromptCardProps = {
  requestId: string;
  toolName: string;
  command: string | null;
  editTarget: string | null;
  blockedPath: string | null;
  decisionReason: string | null;
  busy: boolean;
  canAlwaysAllow: boolean;
  alwaysAllowScope: "session" | "workspace" | "native" | null;
  alwaysAllowDescription: string | null;
  position?: {
    current: number;
    total: number;
  };
  onPrevious?: () => void;
  onNext?: () => void;
  onAllowOnce: (requestId: string) => void;
  onAllowAlways: (requestId: string) => void;
  onDeny: (requestId: string) => void;
};

export function PermissionPromptCard({
  requestId,
  toolName,
  command,
  editTarget,
  busy,
  canAlwaysAllow,
  alwaysAllowScope,
  alwaysAllowDescription,
  position,
  onPrevious,
  onNext,
  onAllowOnce,
  onAllowAlways,
  onDeny,
}: PermissionPromptCardProps) {
  const isEditPermission = EDIT_TOOL_REGEX.test(toolName.trim());
  const promptTitle = isEditPermission ? "Apply this edit?" : "Run this command?";
  const promptDetail = isEditPermission
    ? editTarget ?? "Current file"
    : command ?? `Tool: ${toolName}`;
  const allowOnceLabel = isEditPermission ? "Apply edit" : "Allow once";
  const denyLabel = isEditPermission ? "Keep file" : "Deny";
  const hasPosition = Boolean(position && position.total > 1);
  const [alwaysAllowOpen, setAlwaysAllowOpen] = useState(false);

  useEffect(() => {
    if (busy || !canAlwaysAllow) {
      setAlwaysAllowOpen(false);
    }
  }, [busy, canAlwaysAllow]);

  useEffect(() => {
    setAlwaysAllowOpen(false);
  }, [requestId]);

  const alwaysAllowScopeDescription = alwaysAllowDescription ?? (
    alwaysAllowScope === "workspace"
      ? "Persists this approval in the workspace for matching future requests."
      : alwaysAllowScope === "session"
        ? "Remembers this approval for the current Codex session only."
        : alwaysAllowScope === "native"
          ? "Uses the agent's native always-allow option for matching future requests."
          : "Remembers this choice using the selected agent's permission scope."
  );

  return (
    <section
      className="rounded-lg border border-border/35 bg-background/15 px-2.5 py-2.5 backdrop-blur-sm"
      data-testid={`permission-prompt-${requestId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Permission</p>
          <p className="mt-0.5 text-sm font-medium text-foreground/95">{promptTitle}</p>
        </div>
        {hasPosition ? (
          <span className="rounded-md border border-border/40 bg-background/45 px-2 py-0.5 text-[10px] tabular-nums tracking-wide text-muted-foreground">
            {position!.current} / {position!.total}
          </span>
        ) : (
          <span className="rounded-md border border-border/40 bg-background/45 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            Pending
          </span>
        )}
      </div>

      <pre className="mt-2 overflow-x-auto rounded-lg border border-border/35 bg-background/45 px-2.5 py-2 text-xs text-foreground/90 whitespace-pre-wrap break-words">
        {promptDetail}
      </pre>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {hasPosition ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || !onPrevious || position!.current === 1}
                className="h-7 w-7 p-0"
                onClick={onPrevious}
                aria-label="Previous permission"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || !onNext || position!.current === position!.total}
                className="h-7 w-7 p-0"
                onClick={onNext}
                aria-label="Next permission"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <div className="relative flex items-center">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              className={`h-7 px-2.5 text-[11px] ${canAlwaysAllow ? "rounded-r-none" : "rounded-md"}`}
              onClick={() => onAllowOnce(requestId)}
              aria-label={`${allowOnceLabel} ${requestId}`}
            >
              {allowOnceLabel}
            </Button>
            {canAlwaysAllow ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                className="h-7 w-7 rounded-l-none border-l border-primary-foreground/20 p-0"
                onClick={() => setAlwaysAllowOpen((open) => !open)}
                aria-label={`Show always allow options ${requestId}`}
                aria-expanded={alwaysAllowOpen}
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${alwaysAllowOpen ? "rotate-180" : ""}`} />
              </Button>
            ) : null}

            {canAlwaysAllow && alwaysAllowOpen ? (
              <div
                className="absolute bottom-full right-0 z-50 mb-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border/45 bg-popover p-2 text-xs text-popover-foreground shadow-lg"
                role="menu"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  className="h-7 rounded-md px-2.5 text-[11px]"
                  onClick={() => {
                    setAlwaysAllowOpen(false);
                    onAllowAlways(requestId);
                  }}
                  aria-label={`Always allow ${requestId}`}
                >
                  Always allow
                </Button>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {alwaysAllowScopeDescription}
                </p>
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            className="h-7 rounded-md border-border/55 bg-transparent px-2.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onDeny(requestId)}
            aria-label={`Deny ${requestId}`}
          >
            {denyLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}
