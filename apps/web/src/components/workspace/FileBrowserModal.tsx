import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, FolderGit2, Home, Loader2, Search } from "lucide-react";
import type { FilesystemEntry } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

const RECENT_PATHS_KEY = "codesymphony:recent-browse-paths";
const MAX_RECENT = 5;

function getRecentPaths(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PATHS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function addRecentPath(path: string) {
  const existing = getRecentPaths().filter((p) => p !== path);
  const updated = [path, ...existing].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(updated));
}

interface FileBrowserModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export function FileBrowserModal({ open, onClose, onSelect }: FileBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FilesystemEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [recentPaths] = useState(getRecentPaths);

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    setFilter("");
    try {
      const result = await api.browseFilesystem(path);
      setCurrentPath(result.currentPath);
      setParentPath(result.parentPath);
      setEntries(result.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to browse filesystem");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void browse();
    }
  }, [open, browse]);

  const filteredEntries = useMemo(() => {
    if (!filter) return entries;
    const lower = filter.toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(lower));
  }, [entries, filter]);

  const pathSegments = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split("/").filter(Boolean);
    return parts.map((part, i) => ({
      label: part,
      path: "/" + parts.slice(0, i + 1).join("/"),
    }));
  }, [currentPath]);

  function handleSelect() {
    addRecentPath(currentPath);
    onSelect(currentPath);
    onClose();
  }

  function handleEntryClick(entry: FilesystemEntry) {
    void browse(currentPath + "/" + entry.name);
  }

  function handleEntryDoubleClick(entry: FilesystemEntry) {
    if (entry.isGitRepo) {
      const fullPath = currentPath + "/" + entry.name;
      addRecentPath(fullPath);
      onSelect(fullPath);
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Browse Server Filesystem</DialogTitle>
          <DialogDescription>Navigate to a repository directory and select it.</DialogDescription>
        </DialogHeader>

        {/* Breadcrumb */}
        <nav className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => void browse("/")}
            className="flex items-center rounded px-1 py-0.5 hover:bg-secondary/60 hover:text-foreground"
          >
            <Home className="h-3.5 w-3.5" />
          </button>
          {pathSegments.map((seg) => (
            <span key={seg.path} className="flex items-center">
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              <button
                type="button"
                onClick={() => void browse(seg.path)}
                className="rounded px-1 py-0.5 hover:bg-secondary/60 hover:text-foreground"
              >
                {seg.label}
              </button>
            </span>
          ))}
        </nav>

        {/* Filter input */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter directories..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Recent paths */}
        {!loading && !filter && entries.length > 0 && recentPaths.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Recent</p>
            <div className="flex flex-wrap gap-1">
              {recentPaths.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void browse(p)}
                  className="max-w-full truncate rounded-md bg-secondary/50 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                  title={p}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Directory listing */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border border-border">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="px-3 py-8 text-center text-xs text-destructive">{error}</div>
          ) : (
            <div className="divide-y divide-border/40">
              {parentPath && (
                <button
                  type="button"
                  onClick={() => void browse(parentPath)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-secondary/40"
                >
                  <Folder className="h-4 w-4 shrink-0" />
                  <span>..</span>
                </button>
              )}
              {filteredEntries.length === 0 && (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {filter ? "No matching directories" : "Empty directory"}
                </div>
              )}
              {filteredEntries.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  onClick={() => handleEntryClick(entry)}
                  onDoubleClick={() => handleEntryDoubleClick(entry)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-secondary/40"
                >
                  {entry.isGitRepo ? (
                    <FolderGit2 className="h-4 w-4 shrink-0 text-green-500" />
                  ) : (
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.isGitRepo && (
                    <span className="shrink-0 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                      Git
                    </span>
                  )}
                  {entry.type === "symlink" && (
                    <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                      Symlink
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={currentPath}>
            {currentPath}
          </p>
          <button
            type="button"
            onClick={handleSelect}
            disabled={loading || !currentPath}
            className="shrink-0 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            Select this directory
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
