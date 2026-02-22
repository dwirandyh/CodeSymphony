import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";

interface TeardownErrorDialogProps {
  open: boolean;
  worktreeId: string | null;
  worktreeName: string;
  output: string;
  onForceDelete: (worktreeId: string) => void;
  onClose: () => void;
}

export function TeardownErrorDialog({
  open,
  worktreeId,
  worktreeName,
  output,
  onForceDelete,
  onClose,
}: TeardownErrorDialogProps) {
  const [deleting, setDeleting] = useState(false);

  function handleForceDelete() {
    if (!worktreeId) return;
    setDeleting(true);
    onForceDelete(worktreeId);
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Teardown Failed</DialogTitle>
          <DialogDescription>
            Teardown scripts failed for worktree <strong>{worktreeName}</strong>. You can force delete the worktree or cancel and investigate.
          </DialogDescription>
        </DialogHeader>

        <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/30 bg-black/20 p-3 font-mono text-xs text-muted-foreground">
          {output}
        </pre>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={handleForceDelete} disabled={deleting}>
            {deleting ? "Deleting..." : "Force Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
