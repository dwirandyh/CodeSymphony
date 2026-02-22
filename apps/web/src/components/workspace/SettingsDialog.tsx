import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import type { Repository } from "@codesymphony/shared-types";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  repositories: Repository[];
  onRemoveRepository: (id: string) => void;
}

export function SettingsDialog({ open, onClose, repositories, onRemoveRepository }: SettingsDialogProps) {
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [runScriptText, setRunScriptText] = useState("");
  const [setupText, setSetupText] = useState("");
  const [teardownText, setTeardownText] = useState("");
  const [defaultBranchValue, setDefaultBranchValue] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  // Local cache of saved settings so switching repos doesn't lose unsaved prop data
  const savedScriptsRef = useRef<Record<string, { runScript: string; setup: string; teardown: string; defaultBranch: string }>>({});

  // Select first repo when opening or when repos change
  useEffect(() => {
    if (open && repositories.length > 0 && !selectedRepoId) {
      setSelectedRepoId(repositories[0].id);
    }
  }, [open, repositories, selectedRepoId]);

  // Load scripts when selected repo changes
  useEffect(() => {
    if (!selectedRepoId) return;
    const cached = savedScriptsRef.current[selectedRepoId];
    if (cached) {
      setRunScriptText(cached.runScript);
      setSetupText(cached.setup);
      setTeardownText(cached.teardown);
      setDefaultBranchValue(cached.defaultBranch);
    } else {
      const repo = repositories.find((r) => r.id === selectedRepoId);
      if (!repo) return;
      setRunScriptText(repo.runScript?.join("\n") ?? "");
      setSetupText(repo.setupScript?.join("\n") ?? "");
      setTeardownText(repo.teardownScript?.join("\n") ?? "");
      setDefaultBranchValue(repo.defaultBranch);
    }
    setDirty(false);
    setShowRemoveDialog(false);
  }, [selectedRepoId, repositories]);

  // Fetch branches when selected repo changes
  useEffect(() => {
    if (!selectedRepoId) return;
    let cancelled = false;
    setLoadingBranches(true);
    api.listBranches(selectedRepoId)
      .then((data) => {
        if (!cancelled) setBranches(data);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false);
      });
    return () => { cancelled = true; };
  }, [selectedRepoId]);

  const handleSave = useCallback(async () => {
    if (!selectedRepoId) return;
    setSaving(true);
    try {
      const runScriptLines = runScriptText.trim() ? runScriptText.trim().split("\n").filter(Boolean) : null;
      const setupLines = setupText.trim() ? setupText.trim().split("\n").filter(Boolean) : null;
      const teardownLines = teardownText.trim() ? teardownText.trim().split("\n").filter(Boolean) : null;
      const repo = repositories.find((r) => r.id === selectedRepoId);
      const branchChanged = repo && defaultBranchValue !== repo.defaultBranch;
      await api.updateRepositoryScripts(selectedRepoId, {
        runScript: runScriptLines,
        setupScript: setupLines,
        teardownScript: teardownLines,
        ...(branchChanged ? { defaultBranch: defaultBranchValue } : {}),
      });
      savedScriptsRef.current[selectedRepoId] = { runScript: runScriptText, setup: setupText, teardown: teardownText, defaultBranch: defaultBranchValue };
      setDirty(false);
    } catch {
      // Error is non-critical; user can retry
    } finally {
      setSaving(false);
    }
  }, [selectedRepoId, runScriptText, setupText, teardownText, defaultBranchValue, repositories]);

  const selectedRepo = repositories.find((r) => r.id === selectedRepoId) ?? null;

  if (!open) return null;

  return (
    <>
      {/* Full-page overlay */}
      <div className="fixed inset-0 z-50 flex bg-background p-1 sm:p-2 lg:p-3">
        {/* Left panel — sidebar style */}
        <aside className="flex w-[220px] shrink-0 flex-col rounded-2xl bg-card/75 p-3">
          {/* Back button + title */}
          <button
            type="button"
            className="mb-4 flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
            onClick={onClose}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm font-semibold text-foreground">Settings</span>
          </button>

          {/* Menu items */}
          <div className="space-y-0.5">
            <button
              type="button"
              className="w-full rounded-md bg-secondary px-2 py-1.5 text-left text-xs text-foreground"
            >
              Workspace
            </button>
          </div>
        </aside>

        {/* Right panel — chat panel style */}
        <div className="flex flex-1 flex-col overflow-y-auto p-4">
          <div className="mx-auto w-full max-w-xl">
            {repositories.length > 0 ? (
              <>
                <div className="mb-4">
                  <label className="mb-1.5 block text-xs font-medium">Repository</label>
                  <select
                    className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    value={selectedRepoId ?? ""}
                    onChange={(e) => setSelectedRepoId(e.target.value)}
                  >
                    {repositories.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="mb-4">
                  <label className="mb-1.5 block text-xs font-medium">Default Branch</label>
                  {loadingBranches ? (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading branches...
                    </div>
                  ) : (
                    <select
                      className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                      value={defaultBranchValue}
                      onChange={(e) => {
                        setDefaultBranchValue(e.target.value);
                        setDirty(true);
                      }}
                    >
                      {!branches.includes(defaultBranchValue) && defaultBranchValue && (
                        <option value={defaultBranchValue}>{defaultBranchValue}</option>
                      )}
                      {branches.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    New worktrees will be created from this branch.
                  </p>
                </div>

                <div className="mb-4">
                  <label className="mb-1.5 block text-xs font-medium">Run Script</label>
                  <textarea
                    className="w-full rounded-md border border-border/50 bg-secondary/30 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    rows={3}
                    placeholder={"npm run dev\ndocker-compose up"}
                    value={runScriptText}
                    onChange={(e) => {
                      setRunScriptText(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    One command per line. Executed when you tap the Run button in the chat panel.
                  </p>
                </div>

                <div className="mb-4">
                  <label className="mb-1.5 block text-xs font-medium">Setup Scripts</label>
                  <textarea
                    className="w-full rounded-md border border-border/50 bg-secondary/30 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    rows={5}
                    placeholder={"bun install\ncp .env.example .env"}
                    value={setupText}
                    onChange={(e) => {
                      setSetupText(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    One command per line. Runs sequentially after worktree creation.
                  </p>
                </div>

                <div className="mb-4">
                  <label className="mb-1.5 block text-xs font-medium">Teardown Scripts</label>
                  <textarea
                    className="w-full rounded-md border border-border/50 bg-secondary/30 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                    rows={5}
                    placeholder="docker-compose down"
                    value={teardownText}
                    onChange={(e) => {
                      setTeardownText(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    One command per line. Runs sequentially before worktree deletion.
                  </p>
                </div>

                <div className="mt-auto flex justify-end">
                  <Button
                    size="sm"
                    disabled={!dirty || saving}
                    onClick={() => void handleSave()}
                  >
                    {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                    Save Changes
                  </Button>
                </div>

                {/* ── Remove Repository ── */}
                {selectedRepo && (
                  <>
                    <div className="my-4 border-t border-border/30" />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setShowRemoveDialog(true)}
                    >
                      Remove Repository
                    </Button>
                  </>
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-xs text-muted-foreground">No repositories available</p>
              </div>
            )}
            </div>
          </div>
        </div>

      {/* Remove confirmation dialog */}
      {selectedRepo && (
        <Dialog open={showRemoveDialog} onOpenChange={(isOpen) => { if (!isOpen) setShowRemoveDialog(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Remove {selectedRepo.name}?</DialogTitle>
              <DialogDescription>
                All workspaces will be permanently deleted. The source directory{" "}
                <code className="rounded bg-secondary/60 px-1 py-0.5 text-[11px]">{selectedRepo.rootPath}</code>{" "}
                will not be modified.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowRemoveDialog(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setShowRemoveDialog(false);
                  onRemoveRepository(selectedRepo.id);
                }}
              >
                Remove
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
