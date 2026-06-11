import { useCallback, useMemo, useState } from "react";
import type { IssueReportResult } from "@codesymphony/shared-types";
import { Bug, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { flushPendingDebugLogs } from "../../lib/debugLog";

type IssueReportDialogProps = {
  open: boolean;
  onClose: () => void;
  repositoryId: string | null;
  worktreeId: string | null;
  threadId: string | null;
};

export function IssueReportDialog({
  open,
  onClose,
  repositoryId,
  worktreeId,
  threadId,
}: IssueReportDialogProps) {
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [report, setReport] = useState<IssueReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState(false);
  const trimmedDescription = description.trim();
  const canSubmit = trimmedDescription.length > 0 && !submitting;
  const scopeLabel = useMemo(() => {
    if (threadId) {
      return "Current thread";
    }
    if (worktreeId) {
      return "Current worktree";
    }
    if (repositoryId) {
      return "Current repository";
    }
    return "Current app session";
  }, [repositoryId, threadId, worktreeId]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // [DEBUG-pty-typing] Flush all pending debug entries to server before
      // creating the issue report, so terminal input diagnostics are captured.
      try {
        await flushPendingDebugLogs();
      } catch {
        // Best-effort flush; don't block the report.
      }
      const createdReport = await api.createIssueReport({
        description: trimmedDescription,
        repositoryId,
        worktreeId,
        threadId,
      });
      setReport(createdReport);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to create issue report");
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, repositoryId, threadId, trimmedDescription, worktreeId]);

  const handleClose = useCallback(() => {
    if (submitting) {
      return;
    }
    setDescription("");
    setReport(null);
    setError(null);
    onClose();
  }, [onClose, submitting]);

  const handleOpenReport = useCallback(async () => {
    if (!report) {
      return;
    }

    setOpeningPath(true);
    setError(null);
    try {
      await api.openPath({ targetPath: report.directoryPath });
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open report folder");
    } finally {
      setOpeningPath(false);
    }
  }, [report]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) {
        handleClose();
      }
    }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="h-4 w-4" />
            Report Issue
          </DialogTitle>
          <DialogDescription>
            {report ? "A local diagnostic bundle was created." : `${scopeLabel} diagnostics will be attached automatically.`}
          </DialogDescription>
        </DialogHeader>

        {report ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border/60 bg-secondary/30 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Issue report created
              </div>
              <p className="mt-2 break-all font-mono text-[11px] leading-5 text-muted-foreground">
                {report.directoryPath}
              </p>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                Close
              </Button>
              <Button type="button" onClick={handleOpenReport} disabled={openingPath}>
                {openingPath ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Open Folder
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-foreground">What happened?</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
                placeholder="Describe what you were doing and what went wrong."
                className="min-h-32 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                disabled={submitting}
                autoFocus
              />
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              The bundle excludes raw terminal output, source snippets, environment values, API keys, tokens, and provider credentials.
            </p>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}
                Create Report
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
