import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import type { Repository } from "@codesymphony/shared-types";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  repositories: Repository[];
}

export function SettingsDialog({ open, onClose, repositories }: SettingsDialogProps) {
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [setupText, setSetupText] = useState("");
  const [teardownText, setTeardownText] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Local cache of saved scripts so switching repos doesn't lose unsaved prop data
  const savedScriptsRef = useRef<Record<string, { setup: string; teardown: string }>>({});

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
      setSetupText(cached.setup);
      setTeardownText(cached.teardown);
    } else {
      const repo = repositories.find((r) => r.id === selectedRepoId);
      if (!repo) return;
      setSetupText(repo.setupScript?.join("\n") ?? "");
      setTeardownText(repo.teardownScript?.join("\n") ?? "");
    }
    setDirty(false);
  }, [selectedRepoId, repositories]);

  const handleSave = useCallback(async () => {
    if (!selectedRepoId) return;
    setSaving(true);
    try {
      const setupLines = setupText.trim() ? setupText.trim().split("\n").filter(Boolean) : null;
      const teardownLines = teardownText.trim() ? teardownText.trim().split("\n").filter(Boolean) : null;
      await api.updateRepositoryScripts(selectedRepoId, {
        setupScript: setupLines,
        teardownScript: teardownLines,
      });
      savedScriptsRef.current[selectedRepoId] = { setup: setupText, teardown: teardownText };
      setDirty(false);
    } catch {
      // Error is non-critical; user can retry
    } finally {
      setSaving(false);
    }
  }, [selectedRepoId, setupText, teardownText]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-[400px] max-h-[70vh]">
          {/* Left panel — settings menu */}
          <div className="w-[180px] shrink-0 border-r border-border/30 py-2">
            <div className="space-y-0.5 px-1.5">
              <button
                type="button"
                className="w-full rounded-md bg-secondary px-2 py-1.5 text-left text-xs text-foreground"
              >
                Workspace
              </button>
            </div>
          </div>

          {/* Right panel — repo dropdown + script editors */}
          <div className="flex flex-1 flex-col overflow-y-auto p-4">
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
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-xs text-muted-foreground">No repositories available</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
