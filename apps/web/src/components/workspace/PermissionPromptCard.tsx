import { Button } from "../ui/button";

type PermissionPromptCardProps = {
  requestId: string;
  toolName: string;
  command: string | null;
  editTarget: string | null;
  blockedPath: string | null;
  decisionReason: string | null;
  busy: boolean;
  canAlwaysAllow: boolean;
  onAllowOnce: (requestId: string) => void;
  onAllowAlways: (requestId: string) => void;
  onDeny: (requestId: string) => void;
};

export function PermissionPromptCard({
  requestId,
  toolName,
  command,
  editTarget,
  blockedPath,
  decisionReason,
  busy,
  canAlwaysAllow,
  onAllowOnce,
  onAllowAlways,
  onDeny,
}: PermissionPromptCardProps) {
  const isEditPermission = /^(edit|multiedit|write)$/i.test(toolName.trim());
  const hasMetadata = Boolean(decisionReason || blockedPath);
  const promptMessage = isEditPermission
    ? editTarget
      ? `Do you want Claude to apply this edit to ${editTarget}?`
      : "Do you want Claude to apply this edit?"
    : command
      ? "Claude wants to run this command:"
      : `Claude wants to use ${toolName}.`;
  const allowOnceLabel = isEditPermission ? "Yes, apply edit" : "Allow once";
  const denyLabel = isEditPermission ? "No, keep current file" : "Deny";

  return (
    <section
      className="rounded-xl border border-border/40 bg-background/20 px-3 py-3 backdrop-blur-sm"
      data-testid={`permission-prompt-${requestId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Permission Required</p>
          <p className="mt-1 text-sm text-foreground/90">{promptMessage}</p>
        </div>
        <span className="rounded-full border border-border/45 bg-background/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Awaiting Decision
        </span>
      </div>

      {!isEditPermission && command ? (
        <pre className="mt-3 overflow-x-auto rounded-xl border border-border/35 bg-background/35 px-3 py-2 text-xs text-foreground/90">
          {command}
        </pre>
      ) : !isEditPermission ? (
        <div className="mt-3 rounded-xl border border-border/35 bg-background/35 px-3 py-2 text-xs text-muted-foreground">
          Tool: {toolName}
        </div>
      ) : null}

      {hasMetadata ? (
        <div className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          {decisionReason ? (
            <div className="rounded-lg border border-border/25 bg-secondary/10 px-2 py-1.5">
              Why approval is needed: {decisionReason}
            </div>
          ) : null}
          {blockedPath ? (
            <div className="rounded-lg border border-border/25 bg-secondary/10 px-2 py-1.5">
              Restricted path: {blockedPath}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          className="h-8 rounded-full px-3 text-xs"
          onClick={() => onAllowOnce(requestId)}
          aria-label={`Allow once ${requestId}`}
        >
          {allowOnceLabel}
        </Button>
        {canAlwaysAllow ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => onAllowAlways(requestId)}
            aria-label={`Always allow in workspace ${requestId}`}
          >
            Always allow in this workspace
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          className="h-8 rounded-full border-border/55 bg-transparent px-3 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => onDeny(requestId)}
          aria-label={`Deny ${requestId}`}
        >
          {denyLabel}
        </Button>
      </div>
      {canAlwaysAllow ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Choosing "Always allow in this workspace" will update <code>.claude/settings.local.json</code>.
        </p>
      ) : null}
    </section>
  );
}
