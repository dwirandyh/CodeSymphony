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
  const isEditPermission = EDIT_TOOL_REGEX.test(toolName.trim());
  const hasMetadata = Boolean(decisionReason || blockedPath);
  const promptTitle = isEditPermission ? "Apply this edit?" : "Run this command?";
  const promptDetail = isEditPermission
    ? editTarget ?? "Current file"
    : command ?? `Tool: ${toolName}`;
  const allowOnceLabel = isEditPermission ? "Apply edit" : "Allow once";
  const denyLabel = isEditPermission ? "Keep file" : "Deny";
  const hasDetails = hasMetadata || canAlwaysAllow;

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
        <span className="rounded-md border border-border/40 bg-background/45 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          Pending
        </span>
      </div>

      <pre className="mt-2 overflow-x-auto rounded-lg border border-border/35 bg-background/45 px-2.5 py-2 text-xs text-foreground/90 whitespace-pre-wrap break-words">
        {promptDetail}
      </pre>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          className="h-7 rounded-md px-2.5 text-[11px]"
          onClick={() => onAllowOnce(requestId)}
          aria-label={`Allow once ${requestId}`}
        >
          {allowOnceLabel}
        </Button>
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

      {hasDetails ? (
        <details className="group mt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span>More options</span>
            <span className="text-[10px] transition-transform group-open:rotate-180">▾</span>
          </summary>

          <div className="mt-1.5 space-y-1.5 text-xs text-muted-foreground">
            {decisionReason ? (
              <div className="rounded-md border border-border/25 bg-secondary/10 px-2 py-1.5">
                Why approval is needed: {decisionReason}
              </div>
            ) : null}

            {blockedPath ? (
              <div className="rounded-md border border-border/25 bg-secondary/10 px-2 py-1.5">
                Restricted path: {blockedPath}
              </div>
            ) : null}

            {canAlwaysAllow ? (
              <div className="space-y-1">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  className="h-7 rounded-md px-2.5 text-[11px]"
                  onClick={() => onAllowAlways(requestId)}
                  aria-label={`Always allow in workspace ${requestId}`}
                >
                  Always allow in this workspace
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Updates <code>.claude/settings.local.json</code>.
                </p>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
