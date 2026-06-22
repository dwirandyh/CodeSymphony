import { startTransition, type MutableRefObject, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  Check,
  Copy,
  ClipboardPaste,
  ExternalLink,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Scissors,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { FileEntry, GitChangeEntry, GitChangeStatus } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import {
  loadMaterialIconThemeManifest,
  resolveMaterialIconThemeIconUrl,
  type MaterialIconThemeManifest,
} from "../../lib/materialIconTheme";
import { queryKeys } from "../../lib/queryKeys";
import { MOBILE_CONTEXT_Z_CLASS } from "../../lib/mobileStacking";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { writeExplorerEntryDragData } from "./explorerDrag";

const DEFAULT_EXPANDED_ROOT_PATHS = ["src", "app", "apps", "packages"];
const PENDING_EXPLORER_SKELETON_WIDTHS = ["58%", "72%", "46%", "67%", "54%", "61%", "39%"];

type SourceControlStatus = "tracked" | "untracked" | "ignored";
type ExplorerFileEntry = FileEntry & {
  sourceControlStatus?: SourceControlStatus;
};

type ExplorerNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  sourceControlStatus?: SourceControlStatus;
  children: ExplorerNode[];
  changeCount: number;
  status: GitChangeStatus | null;
};

type ExplorerActionMode = "file" | "directory" | "rename";

type PendingExplorerInput = {
  mode: ExplorerActionMode;
  parentPath: string;
  targetPath?: string;
  initialName: string;
  placeholder?: string;
  depth: number;
};

type ExplorerMenuState = {
  x: number;
  y: number;
  entry: ExplorerFileEntry | null;
};

type ExplorerClipboardState = {
  operation: "copy" | "cut";
  entry: ExplorerFileEntry;
};

type OverwriteConfirmState = {
  operation: "copy" | "move";
  sourcePath: string;
  destinationPath: string;
  entryName: string;
  resolve: (overwrite: boolean) => void;
};

type ExplorerSelectedEntry = {
  entry: ExplorerFileEntry;
  depth: number;
};

type ExplorerDragPayload = {
  path: string;
  type: "file" | "directory";
};

type ExplorerActions = {
  selectedEntry: ExplorerSelectedEntry | null;
  overwriteConfirm: OverwriteConfirmState | null;
  pendingInput: PendingExplorerInput | null;
  busy: boolean;
  error: string | null;
  deleteTarget: ExplorerFileEntry | null;
  menu: ExplorerMenuState | null;
  clipboard: ExplorerClipboardState | null;
  beginCreateFile: (parentPath: string, depth: number) => void;
  beginCreateDirectory: (parentPath: string, depth: number) => void;
  beginRename: (entry: ExplorerFileEntry, depth: number) => void;
  closeMenu: () => void;
  openMenu: (event: React.MouseEvent, entry: ExplorerFileEntry | null) => void;
  requestDelete: (entry: ExplorerFileEntry) => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
  submitInput: (name: string) => void;
  cancelInput: () => void;
  copyEntry: (entry: ExplorerFileEntry) => void;
  cutEntry: (entry: ExplorerFileEntry) => void;
  pasteInto: (destinationDirectoryPath: string) => void;
  openExternal: (entry: ExplorerFileEntry) => void;
  refresh: () => void;
  setSelectedEntry: (entry: ExplorerSelectedEntry | null) => void;
  cancelOverwrite: () => void;
  confirmOverwrite: () => void;
  handleDrop: (destinationPath: string, dragData: ExplorerDragPayload, dropEffect: "copy" | "move") => void;
  dropTargetPath: string | null;
  setDropTargetPath: (path: string | null) => void;
};

function fileName(filePath: string): string {
  const parts = filePath.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? filePath;
}

function parentPath(filePath: string): string {
  const parts = filePath.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -1).join("/");
}

function joinPath(directoryPath: string, name: string): string {
  const trimmedName = name.trim().replace(/^\/+|\/+$/g, "");
  return directoryPath ? `${directoryPath}/${trimmedName}` : trimmedName;
}

function isPathSameOrDescendant(pathToCheck: string, possibleParentPath: string): boolean {
  return pathToCheck === possibleParentPath || pathToCheck.startsWith(`${possibleParentPath}/`);
}

function isSafeNewItemName(name: string): boolean {
  const trimmedName = name.trim();
  return trimmedName.length > 0
    && !trimmedName.split("/").some((part) => part === "." || part === ".." || part.length === 0);
}

function changeDotClass(status: GitChangeStatus | null): string {
  switch (status) {
    case "added":
    case "untracked":
      return "bg-emerald-500";
    case "deleted":
      return "bg-rose-500";
    case "renamed":
      return "bg-sky-500";
    case "modified":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/30";
  }
}

function parentDirectoryPaths(filePath: string): string[] {
  const parts = filePath.split("/").filter((part) => part.length > 0);
  const parents: string[] = [];
  let currentPath = "";

  for (let index = 0; index < parts.length - 1; index += 1) {
    currentPath = currentPath ? `${currentPath}/${parts[index]}` : parts[index]!;
    parents.push(currentPath);
  }

  return parents;
}

function mergeExpandedPaths(current: Set<string>, paths: string[]): Set<string> {
  let changed = false;
  const next = new Set(current);

  for (const path of paths) {
    if (!next.has(path)) {
      next.add(path);
      changed = true;
    }
  }

  return changed ? next : current;
}

function toggleExpandedPath(current: Set<string>, path: string): Set<string> {
  const next = new Set(current);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

function buildGitDecorations(gitEntries: GitChangeEntry[]) {
  const statusByPath = new Map<string, GitChangeStatus>();
  const changeCountByDirectory = new Map<string, number>();

  for (const entry of gitEntries) {
    statusByPath.set(entry.path, entry.status);

    for (const directoryPath of parentDirectoryPaths(entry.path)) {
      changeCountByDirectory.set(directoryPath, (changeCountByDirectory.get(directoryPath) ?? 0) + 1);
    }
  }

  return {
    statusByPath,
    changeCountByDirectory,
  };
}

function ExplorerNodeIcon({
  manifest,
  path,
  type,
  isExpanded,
  depth,
}: {
  manifest: MaterialIconThemeManifest | null;
  path: string;
  type: "file" | "directory";
  isExpanded: boolean;
  depth: number;
}) {
  const iconSrc = manifest
    ? resolveMaterialIconThemeIconUrl(manifest, {
      path,
      type,
      isExpanded,
      isRoot: depth === 0,
    })
    : null;

  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt=""
        aria-hidden="true"
        className="h-4 w-4 shrink-0 object-contain"
        loading="lazy"
      />
    );
  }

  if (type === "directory") {
    return isExpanded
      ? <FolderOpen className="h-4 w-4 shrink-0 text-sky-500" />
      : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }

  return <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function insertNode(root: ExplorerNode, entry: ExplorerFileEntry, statusByPath: Map<string, GitChangeStatus>) {
  const parts = entry.path.split("/").filter((part) => part.length > 0);
  let current = root;
  let currentPath = "";

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const isLeaf = index === parts.length - 1;
    const nodeType = isLeaf ? entry.type : "directory";

    let child = current.children.find((candidate) => candidate.name === part && candidate.type === nodeType);
    if (!child) {
      child = {
        name: part,
        path: currentPath,
        type: nodeType,
        sourceControlStatus: undefined,
        children: [],
        changeCount: 0,
        status: null,
      };
      current.children.push(child);
    }

    current = child;
  }

  const status = statusByPath.get(entry.path) ?? null;
  if (status) {
    current.status = status;
  }
  current.sourceControlStatus = entry.sourceControlStatus;
}

function sortTree(node: ExplorerNode): ExplorerNode {
  node.children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  node.changeCount = node.status ? 1 : 0;
  for (const child of node.children) {
    sortTree(child);
    node.changeCount += child.changeCount;
  }

  return node;
}

function buildTree(entries: ExplorerFileEntry[], gitEntries: GitChangeEntry[]): ExplorerNode {
  const root: ExplorerNode = {
    name: "",
    path: "",
    type: "directory",
    children: [],
    changeCount: 0,
    status: null,
    sourceControlStatus: "tracked",
  };
  const statusByPath = new Map(gitEntries.map((entry) => [entry.path, entry.status] as const));

  for (const entry of entries) {
    insertNode(root, entry, statusByPath);
  }

  return sortTree(root);
}

function PendingExplorerSkeleton() {
  return (
    <div data-testid="pending-worktree-explorer-skeleton" className="space-y-1.5 px-1 py-1">
      {PENDING_EXPLORER_SKELETON_WIDTHS.map((width, index) => (
        <div
          key={`${width}-${index}`}
          className="flex items-center gap-2 rounded-md px-2 py-1.5"
          style={{ paddingLeft: `${8 + (index % 3) * 14}px` }}
        >
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded-sm bg-muted/70" />
          <div className="h-4 w-4 shrink-0 animate-pulse rounded-sm bg-muted/70" />
          <div className="h-3.5 animate-pulse rounded bg-muted/70" style={{ width }} />
        </div>
      ))}
    </div>
  );
}

function InlineExplorerInput({
  pendingInput,
  onSubmit,
  onCancel,
}: {
  pendingInput: PendingExplorerInput;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(pendingInput.initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const getCurrentValue = () => inputRef.current?.value ?? value;

  useEffect(() => {
    setValue(pendingInput.initialName);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [pendingInput]);

  return (
    <form
      className="flex items-center gap-2 rounded-md px-2 py-1"
      style={{ paddingLeft: `${8 + pendingInput.depth * 14}px` }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(getCurrentValue());
      }}
    >
      {pendingInput.mode === "directory" ? (
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <Input
        ref={inputRef}
        value={value}
        placeholder={pendingInput.placeholder}
        className="h-7 min-w-0 flex-1 px-2 text-xs"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit(getCurrentValue());
            return;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (pendingInput.mode !== "rename" && value.trim() === pendingInput.initialName.trim()) {
            onCancel();
          }
        }}
      />
      <button
        type="submit"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        aria-label="Confirm file operation"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        onClick={onCancel}
        aria-label="Cancel file operation"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}

function ExplorerToolbar({
  searchTerm,
  onSearchChange,
  onNewFile,
  onNewDirectory,
  onCollapseAll,
  onRefresh,
  error,
  busy,
}: {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  onNewFile: () => void;
  onNewDirectory: () => void;
  onCollapseAll: () => void;
  onRefresh: () => void;
  error: string | null;
  busy: boolean;
}) {
  return (
    <div className="border-b border-border/40 px-2 py-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchTerm}
          placeholder="Search files..."
          className="h-8 pl-7 pr-7 text-xs"
          onChange={(event) => onSearchChange(event.target.value)}
        />
        {searchTerm ? (
          <button
            type="button"
            className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={() => onSearchChange("")}
            aria-label="Clear file search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNewFile} disabled={busy} aria-label="New file">
          <FilePlus2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNewDirectory} disabled={busy} aria-label="New folder">
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCollapseAll} disabled={busy} aria-label="Collapse all">
          <ChevronsUp className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefresh} disabled={busy} aria-label="Refresh files">
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
        </Button>
      </div>
      {error ? (
        <div className="mt-1 truncate px-1 text-[11px] text-destructive" title={error}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ExplorerContextMenu({
  menu,
  actions,
  canMutate,
  onTreeMutationStart,
}: {
  menu: ExplorerMenuState | null;
  actions: ExplorerActions;
  canMutate: boolean;
  onTreeMutationStart?: () => void;
}) {
  if (!menu) {
    return null;
  }

  const entry = menu.entry;
  const directoryPath = entry?.type === "directory" ? entry.path : entry ? parentPath(entry.path) : "";
  const depth = entry?.type === "directory" ? entry.path.split("/").filter(Boolean).length + 1 : 0;
  const clipboardEntry = actions.clipboard?.entry ?? null;
  const pasteDisabled = !canMutate
    || (
      clipboardEntry?.type === "directory"
      && isPathSameOrDescendant(directoryPath, clipboardEntry.path)
    );

  function item(label: string, Icon: LucideIcon, onClick: () => void, disabled = false) {
    function selectItem() {
      if (disabled) return;
      onClick();
      actions.closeMenu();
    }

    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-45"
        disabled={disabled}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          selectItem();
        }}
        onClick={(event) => {
          if (event.detail > 0) return;
          selectItem();
        }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  }

  return (
    <div
      className={cn("fixed w-48 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-xl", MOBILE_CONTEXT_Z_CLASS)}
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {item("New File", FilePlus2, () => {
        onTreeMutationStart?.();
        actions.beginCreateFile(directoryPath, depth);
      }, !canMutate)}
      {item("New Folder", FolderPlus, () => {
        onTreeMutationStart?.();
        actions.beginCreateDirectory(directoryPath, depth);
      }, !canMutate)}
      {entry ? <div className="my-1 h-px bg-border/60" /> : null}
      {entry ? item("Copy", Copy, () => actions.copyEntry(entry), !canMutate) : null}
      {entry ? item("Cut", Scissors, () => actions.cutEntry(entry), !canMutate) : null}
      {item(
        actions.clipboard ? `Paste ${fileName(actions.clipboard.entry.path)}` : "Paste from Clipboard",
        ClipboardPaste,
        () => {
          onTreeMutationStart?.();
          actions.pasteInto(directoryPath);
        },
        pasteDisabled,
      )}
      {entry ? <div className="my-1 h-px bg-border/60" /> : null}
      {entry && entry.type === "file" ? item("Open in Editor", ExternalLink, () => actions.openExternal(entry), !canMutate) : null}
      {entry ? item("Rename", Pencil, () => {
        onTreeMutationStart?.();
        actions.beginRename(entry, entry.path.split("/").filter(Boolean).length - 1);
      }, !canMutate) : null}
      {entry ? item("Delete", Trash2, () => actions.requestDelete(entry), !canMutate) : null}
    </div>
  );
}

function ExplorerDeleteDialog({ actions }: { actions: ExplorerActions }) {
  const target = actions.deleteTarget;
  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => {
      if (!open) {
        actions.cancelDelete();
      }
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {target ? fileName(target.path) : "path"}?</DialogTitle>
          <DialogDescription>
            This removes the selected {target?.type === "directory" ? "folder" : "file"} from the worktree.
          </DialogDescription>
        </DialogHeader>
        <div className="truncate rounded-md border border-border/70 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          {target?.path}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={actions.cancelDelete} disabled={actions.busy}>Cancel</Button>
          <Button onClick={actions.confirmDelete} disabled={actions.busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExplorerOverwriteDialog({ actions }: { actions: ExplorerActions }) {
  const confirm = actions.overwriteConfirm;
  return (
    <Dialog open={Boolean(confirm)} onOpenChange={(open) => {
      if (!open) {
        actions.cancelOverwrite();
      }
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Overwrite {confirm?.entryName ?? "file"}?</DialogTitle>
          <DialogDescription>
            A {confirm?.operation === "copy" ? "copy" : "move"} operation would overwrite an existing item at the destination. Do you want to replace it?
          </DialogDescription>
        </DialogHeader>
        <div className="truncate rounded-md border border-border/70 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          {confirm?.destinationPath}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={actions.cancelOverwrite} disabled={actions.busy}>Cancel</Button>
          <Button onClick={actions.confirmOverwrite} disabled={actions.busy} className="bg-primary text-primary-foreground hover:bg-primary/90">
            Overwrite
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useExplorerActions({
  worktreeId,
  setExpandedPaths,
  onInvalidate,
}: {
  worktreeId?: string | null;
  setExpandedPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
  onInvalidate: () => void;
}): ExplorerActions {
  const [pendingInput, setPendingInput] = useState<PendingExplorerInput | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExplorerFileEntry | null>(null);
  const [menu, setMenu] = useState<ExplorerMenuState | null>(null);
  const [clipboard, setClipboard] = useState<ExplorerClipboardState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntryState] = useState<ExplorerSelectedEntry | null>(null);
  const [overwriteConfirm, setOverwriteConfirm] = useState<OverwriteConfirmState | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) {
      return;
    }

    const close = () => setMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu]);

  async function runOperation(operation: () => Promise<unknown>, expandPaths: string[] = [], onSuccess?: () => void) {
    if (!worktreeId || busy) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await operation();
      if (expandPaths.length > 0) {
        startTransition(() => {
          setExpandedPaths((current) => mergeExpandedPaths(current, expandPaths));
        });
      }
      onInvalidate();
      setPendingInput(null);
      setDeleteTarget(null);
      onSuccess?.();
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "File operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function runTransferOperation(
    operation: "copy" | "move",
    sourcePath: string,
    destinationDirectoryPath: string,
    expandPaths: string[] = [],
    onSuccess?: () => void,
  ) {
    if (!worktreeId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const apiCall = operation === "copy" ? api.copyWorktreePath : api.moveWorktreePath;
      await apiCall(worktreeId, { sourcePath, destinationDirectoryPath });
      if (expandPaths.length > 0) {
        startTransition(() => {
          setExpandedPaths((current) => mergeExpandedPaths(current, expandPaths));
        });
      }
      onInvalidate();
      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Operation failed";
      if (message.includes("already exists") || message.includes("Target already exists")) {
        const shouldOverwrite = await new Promise<boolean>((resolve) => {
          setOverwriteConfirm({
            operation,
            sourcePath,
            destinationPath: destinationDirectoryPath
              ? `${destinationDirectoryPath}/${fileName(sourcePath)}`
              : fileName(sourcePath),
            entryName: fileName(sourcePath),
            resolve,
          });
        });
        if (shouldOverwrite) {
          try {
            const apiCall = operation === "copy" ? api.copyWorktreePath : api.moveWorktreePath;
            await apiCall(worktreeId, { sourcePath, destinationDirectoryPath, overwrite: true });
            if (expandPaths.length > 0) {
              startTransition(() => {
                setExpandedPaths((current) => mergeExpandedPaths(current, expandPaths));
              });
            }
            onInvalidate();
            onSuccess?.();
          } catch (retryErr) {
            setError(retryErr instanceof Error ? retryErr.message : "Operation failed");
          }
        }
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    pendingInput,
    busy,
    error,
    deleteTarget,
    menu,
    clipboard,
    selectedEntry,
    overwriteConfirm,
    dropTargetPath,
    setDropTargetPath,
    setSelectedEntry(entry) {
      setSelectedEntryState(entry);
    },
    cancelOverwrite() {
      if (overwriteConfirm) {
        overwriteConfirm.resolve(false);
        setOverwriteConfirm(null);
      }
    },
    confirmOverwrite() {
      if (overwriteConfirm) {
        overwriteConfirm.resolve(true);
        setOverwriteConfirm(null);
      }
    },
    async handleDrop(destinationPath, dragData, dropEffect) {
      if (!worktreeId) return;
      if (parentPath(dragData.path) === destinationPath && dropEffect === "copy") return;
      if (isPathSameOrDescendant(destinationPath, dragData.path)) return;
      void runTransferOperation(
        dropEffect,
        dragData.path,
        destinationPath,
        destinationPath ? [destinationPath] : [],
      );
    },
    beginCreateFile(parentDirectoryPath, depth) {
      setError(null);
      if (parentDirectoryPath) {
        startTransition(() => {
          setExpandedPaths((current) => mergeExpandedPaths(current, [parentDirectoryPath]));
        });
      }
      setPendingInput({ mode: "file", parentPath: parentDirectoryPath, initialName: "", placeholder: "untitled.txt", depth });
    },
    beginCreateDirectory(parentDirectoryPath, depth) {
      setError(null);
      if (parentDirectoryPath) {
        startTransition(() => {
          setExpandedPaths((current) => mergeExpandedPaths(current, [parentDirectoryPath]));
        });
      }
      setPendingInput({ mode: "directory", parentPath: parentDirectoryPath, initialName: "", placeholder: "new-folder", depth });
    },
    beginRename(entry, depth) {
      setError(null);
      setPendingInput({
        mode: "rename",
        parentPath: parentPath(entry.path),
        targetPath: entry.path,
        initialName: fileName(entry.path),
        depth,
      });
    },
    closeMenu() {
      setMenu(null);
    },
    openMenu(event, entry) {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, entry });
    },
    requestDelete(entry) {
      setDeleteTarget(entry);
    },
    cancelDelete() {
      if (!busy) {
        setDeleteTarget(null);
      }
    },
    confirmDelete() {
      if (!deleteTarget) {
        return;
      }
      void runOperation(() => api.deleteWorktreePath(worktreeId!, { path: deleteTarget.path }));
    },
    submitInput(name) {
      const input = pendingInput;
      if (!input || !isSafeNewItemName(name)) {
        setError("Use a valid file or folder name");
        return;
      }

      if (input.mode === "rename") {
        void runOperation(
          () => api.renameWorktreePath(worktreeId!, { path: input.targetPath!, name: name.trim() }),
          input.parentPath ? [input.parentPath] : [],
        );
        return;
      }

      const targetPath = joinPath(input.parentPath, name);
      if (input.mode === "file") {
        void runOperation(
          () => api.createWorktreeFile(worktreeId!, { path: targetPath }),
          input.parentPath ? [input.parentPath] : [],
        );
        return;
      }

      void runOperation(
        () => api.createWorktreeDirectory(worktreeId!, { path: targetPath }),
        [input.parentPath, targetPath].filter(Boolean),
      );
    },
    cancelInput() {
      if (!busy) {
        setPendingInput(null);
      }
    },
    copyEntry(entry) {
      setError(null);
      setClipboard({ operation: "copy", entry });
    },
    cutEntry(entry) {
      setError(null);
      setClipboard({ operation: "cut", entry });
    },
    pasteInto(destinationDirectoryPath) {
      const clipboardState = clipboard;
      const destinationPath = destinationDirectoryPath.trim();
      if (!clipboardState) {
        void runOperation(
          () => api.pasteHostClipboardPaths(worktreeId!, { destinationDirectoryPath: destinationPath }),
          destinationPath ? [destinationPath] : [],
        );
        return;
      }

      if (
        clipboardState.entry.type === "directory"
        && isPathSameOrDescendant(destinationPath, clipboardState.entry.path)
      ) {
        setError("Cannot paste a folder into itself");
        return;
      }

      const request = {
        sourcePath: clipboardState.entry.path,
        destinationDirectoryPath: destinationPath,
      };
      void runTransferOperation(
        clipboardState.operation === "cut" ? "move" : clipboardState.operation,
        clipboardState.entry.path,
        destinationPath,
        destinationPath ? [destinationPath] : [],
        clipboardState.operation === "cut" ? () => setClipboard(null) : undefined,
      );
    },
    openExternal(entry) {
      if (!worktreeId || entry.type !== "file") {
        return;
      }
      void runOperation(() => api.openWorktreeFile(worktreeId, { path: entry.path }));
    },
    refresh() {
      onInvalidate();
    },
  };
}

function useExplorerPresentationState(
  activeFilePath: string | null,
  initialExpandedPaths: string[] = [],
) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(initialExpandedPaths));
  const [iconManifest, setIconManifest] = useState<MaterialIconThemeManifest | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadMaterialIconThemeManifest().then((manifest) => {
      if (!cancelled) {
        setIconManifest(manifest);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeFilePath) {
      return;
    }

    const pathsToExpand = parentDirectoryPaths(activeFilePath);
    if (pathsToExpand.length === 0) {
      return;
    }

    setExpandedPaths((current) => mergeExpandedPaths(current, pathsToExpand));
  }, [activeFilePath]);

  useEffect(() => {
    if (!activeFilePath || !scrollAreaRef.current) {
      return;
    }

    const activeButton = Array.from(
      scrollAreaRef.current.querySelectorAll<HTMLButtonElement>("button[data-explorer-path]"),
    ).find((button) => button.dataset.explorerPath === activeFilePath);

    activeButton?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeFilePath, expandedPaths]);

  return {
    expandedPaths,
    setExpandedPaths,
    iconManifest,
    scrollAreaRef,
  };
}

function WorkspaceExplorerShell({
  pending,
  loading,
  empty,
  error,
  onClose,
  scrollAreaRef,
  toolbar,
  onRootContextMenu,
  onRootDragOver,
  onRootDragLeave,
  onRootDrop,
  onKeyDown,
  onBlur,
  showHeader = true,
  children,
}: {
  pending: boolean;
  loading: boolean;
  empty: boolean;
  error: string | null;
  onClose: () => void;
  scrollAreaRef: MutableRefObject<HTMLDivElement | null>;
  toolbar?: ReactNode;
  onRootContextMenu?: (event: React.MouseEvent) => void;
  onRootDragOver?: (event: React.DragEvent) => void;
  onRootDragLeave?: (event: React.DragEvent) => void;
  onRootDrop?: (event: React.DragEvent) => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
  showHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn(
      "flex h-full flex-col overflow-hidden bg-transparent",
      showHeader && "border-l border-border/40",
    )}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {showHeader ? (
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
            Explorer
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground/60 hover:text-foreground"
            onClick={onClose}
            aria-label="Close Explorer"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}

      {toolbar}

      <ScrollArea
        ref={(node) => {
          scrollAreaRef.current = node;
        }}
        onBlur={onBlur}
        className={cn("min-h-0 flex-1 px-2 py-2", !showHeader && "pb-4")}
        onContextMenu={onRootContextMenu}
        onDragOver={onRootDragOver}
        onDragLeave={onRootDragLeave}
        onDrop={onRootDrop}
      >
        {pending ? (
          <PendingExplorerSkeleton />
        ) : loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-[11px] text-destructive">
            {error}
          </div>
        ) : empty ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            No files available for this worktree.
          </div>
        ) : (
          <div className="space-y-0.5">{children}</div>
        )}
      </ScrollArea>
    </section>
  );
}

function createExplorerKeyHandler(actions: ExplorerActions, canMutate: boolean) {
  return (event: React.KeyboardEvent) => {
    const selected = actions.selectedEntry;
    if (!selected || !canMutate) return;

    const isMeta = event.metaKey || event.ctrlKey;
    const entry = selected.entry;

    switch (event.key) {
      case "Delete":
      case "Backspace":
        event.preventDefault();
        actions.requestDelete(entry);
        break;
      case "F2":
        event.preventDefault();
        actions.beginRename(entry, selected.depth);
        break;
      case "c":
        if (isMeta) {
          event.preventDefault();
          actions.copyEntry(entry);
        }
        break;
      case "x":
        if (isMeta) {
          event.preventDefault();
          actions.cutEntry(entry);
        }
        break;
      case "v":
        if (isMeta) {
          event.preventDefault();
          const dirPath = entry.type === "directory" ? entry.path : parentPath(entry.path);
          actions.pasteInto(dirPath);
        }
        break;
    }
  };
}

function WorkspaceExplorerFlatContent({
  worktreeId,
  gitEntries,
  entries,
  pending = false,
  loading,
  activeFilePath,
  onOpenFile,
  onClose,
  showHeader = true,
}: {
  worktreeId?: string | null;
  entries: ExplorerFileEntry[];
  gitEntries: GitChangeEntry[];
  pending?: boolean;
  loading: boolean;
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  showHeader?: boolean;
}) {
  const tree = useMemo(() => buildTree(entries, gitEntries), [entries, gitEntries]);
  const { expandedPaths, setExpandedPaths, iconManifest, scrollAreaRef } = useExplorerPresentationState(
    activeFilePath,
    DEFAULT_EXPANDED_ROOT_PATHS,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const actions = useExplorerActions({ worktreeId, setExpandedPaths, onInvalidate: () => {} });
  const canMutate = Boolean(worktreeId) && !pending;
  const filteredEntries = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) {
      return [];
    }
    return entries
      .filter((entry) => entry.path.toLowerCase().includes(query))
      .slice(0, 80);
  }, [entries, searchTerm]);

  function toggleDirectory(path: string) {
    startTransition(() => {
      setExpandedPaths((current) => toggleExpandedPath(current, path));
    });
  }

  function renderNode(node: ExplorerNode, depth: number) {
    const isDirectory = node.type === "directory";
    const isExpanded = isDirectory ? expandedPaths.has(node.path) : false;
    const isActive = !isDirectory && activeFilePath === node.path;
    const directoryChanged = isDirectory && node.changeCount > 0;
    const isDropTarget = isDirectory && actions.dropTargetPath === node.path;

    if (actions.pendingInput?.mode === "rename" && actions.pendingInput.targetPath === node.path) {
      return (
        <InlineExplorerInput
          key={node.path}
          pendingInput={actions.pendingInput}
          onSubmit={actions.submitInput}
          onCancel={actions.cancelInput}
        />
      );
    }

    return (
      <div key={node.path || "__root__"}>
        <button
          type="button"
          draggable
          data-explorer-path={!isDirectory ? node.path : undefined}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40",
            (node.sourceControlStatus === "untracked" || node.sourceControlStatus === "ignored") && !isActive && "text-muted-foreground/55",
            isActive && "bg-secondary text-foreground",
            isDropTarget && "bg-primary/10 ring-1 ring-primary/50",
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => {
            if (isDirectory) {
              toggleDirectory(node.path);
              return;
            }
            onOpenFile(node.path);
          }}
          onContextMenu={(event) => actions.openMenu(event, node)}
          onFocus={() => {
            actions.setSelectedEntry({ entry: node, depth });
          }}
          onDragStart={(event) => {
            writeExplorerEntryDragData(event.dataTransfer, node);
          }}
          onDragOver={isDirectory ? (event) => {
            if (hasExplorerEntryDragData(event.dataTransfer)) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
              actions.setDropTargetPath(node.path);
            }
          } : undefined}
          onDragLeave={isDirectory ? () => {
            if (actions.dropTargetPath === node.path) {
              actions.setDropTargetPath(null);
            }
          } : undefined}
          onDrop={isDirectory ? (event) => {
            event.preventDefault();
            event.stopPropagation();
            actions.setDropTargetPath(null);
            const dragData = readExplorerEntryDragData(event.dataTransfer);
            if (dragData) {
              void actions.handleDrop(node.path, dragData, event.shiftKey ? "copy" : "move");
            }
          } : undefined}
        >
          {isDirectory ? (
            isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          <ExplorerNodeIcon
            manifest={iconManifest}
            path={node.path}
            type={node.type}
            isExpanded={isExpanded}
            depth={depth}
          />

          <span className="min-w-0 flex-1 truncate">{node.name || "/"}</span>

          {directoryChanged ? (
            <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {node.changeCount}
            </span>
          ) : null}

          {!isDirectory && node.status ? (
            <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", changeDotClass(node.status))} />
          ) : null}
        </button>

        {isDirectory && isExpanded ? (
          <div>
            {actions.pendingInput?.parentPath === node.path ? (
              <InlineExplorerInput
                pendingInput={actions.pendingInput}
                onSubmit={actions.submitInput}
                onCancel={actions.cancelInput}
              />
            ) : null}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderSearchResult(entry: ExplorerFileEntry) {
    const isDirectory = entry.type === "directory";
    return (
      <button
        key={entry.path}
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40"
        onClick={() => {
          if (isDirectory) {
            setSearchTerm("");
            startTransition(() => {
              setExpandedPaths((current) => mergeExpandedPaths(current, [entry.path]));
            });
            return;
          }
          onOpenFile(entry.path);
        }}
        onContextMenu={(event) => actions.openMenu(event, entry)}
      >
        <ExplorerNodeIcon manifest={iconManifest} path={entry.path} type={entry.type} isExpanded={false} depth={0} />
        <span className="min-w-0 flex-1 truncate">{entry.path}</span>
      </button>
    );
  }

  return (
    <>
      <WorkspaceExplorerShell
        pending={pending}
        loading={loading}
        empty={actions.pendingInput ? false : searchTerm.trim() ? filteredEntries.length === 0 : tree.children.length === 0}
        error={null}
        onClose={onClose}
        scrollAreaRef={scrollAreaRef}
        showHeader={showHeader}
        toolbar={(
          <ExplorerToolbar
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            onNewFile={() => {
              setSearchTerm("");
              actions.beginCreateFile("", 0);
            }}
            onNewDirectory={() => {
              setSearchTerm("");
              actions.beginCreateDirectory("", 0);
            }}
            onCollapseAll={() => startTransition(() => setExpandedPaths(new Set()))}
            onRefresh={actions.refresh}
            error={actions.error}
            busy={actions.busy}
          />
        )}
        onRootContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            actions.openMenu(event, null);
          }
        }}
        onKeyDown={createExplorerKeyHandler(actions, canMutate)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            actions.setSelectedEntry(null);
          }
        }}
        onRootDragOver={(event) => {
          if (hasExplorerEntryDragData(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
            actions.setDropTargetPath("");
          }
        }}
        onRootDragLeave={() => {
          if (actions.dropTargetPath === "") {
            actions.setDropTargetPath(null);
          }
        }}
        onRootDrop={(event) => {
          event.preventDefault();
          actions.setDropTargetPath(null);
          const dragData = readExplorerEntryDragData(event.dataTransfer);
          if (dragData) {
            void actions.handleDrop("", dragData, event.shiftKey ? "copy" : "move");
          }
        }}
      >
        {searchTerm.trim()
          ? filteredEntries.map(renderSearchResult)
          : (
              <>
                {actions.pendingInput?.parentPath === "" && actions.pendingInput.mode !== "rename" ? (
                  <InlineExplorerInput
                    pendingInput={actions.pendingInput}
                    onSubmit={actions.submitInput}
                    onCancel={actions.cancelInput}
                  />
                ) : null}
                {tree.children.map((node) => renderNode(node, 0))}
              </>
            )}
      </WorkspaceExplorerShell>
      <ExplorerContextMenu menu={actions.menu} actions={actions} canMutate={canMutate} onTreeMutationStart={() => setSearchTerm("")} />
      <ExplorerDeleteDialog actions={actions} />
      <ExplorerOverwriteDialog actions={actions} />
      <ExplorerOverwriteDialog actions={actions} />
    </>
  );
}

interface WorkspaceExplorerPanelProps {
  worktreeId?: string | null;
  gitEntries: GitChangeEntry[];
  entries?: ExplorerFileEntry[];
  pending?: boolean;
  loading?: boolean;
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
  showHeader?: boolean;
}

function WorkspaceExplorerPanelBridge({
  worktreeId,
  gitEntries,
  pending = false,
  activeFilePath,
  onOpenFile,
  onClose,
  showHeader = true,
}: Required<Pick<WorkspaceExplorerPanelProps, "gitEntries" | "activeFilePath" | "onOpenFile" | "onClose">> & {
  worktreeId?: string | null;
  pending?: boolean;
  showHeader?: boolean;
}) {
  const { expandedPaths, setExpandedPaths, iconManifest, scrollAreaRef } = useExplorerPresentationState(activeFilePath);
  const [searchTerm, setSearchTerm] = useState("");
  const queryClient = useQueryClient();
  const actions = useExplorerActions({
    worktreeId,
    setExpandedPaths,
    onInvalidate: () => {
      if (!worktreeId) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileIndex(worktreeId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileTreeScope(worktreeId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitDiffScope(worktreeId) });
    },
  });
  const initialExpansionAppliedRef = useRef<string | null>(null);
  const { statusByPath, changeCountByDirectory } = useMemo(() => buildGitDecorations(gitEntries), [gitEntries]);
  const canMutate = Boolean(worktreeId) && !pending;

  useEffect(() => {
    initialExpansionAppliedRef.current = null;
    startTransition(() => {
      setExpandedPaths(new Set(activeFilePath ? parentDirectoryPaths(activeFilePath) : []));
    });
  }, [activeFilePath, setExpandedPaths, worktreeId]);

  const requestedPaths = useMemo(
    () => ["", ...Array.from(expandedPaths).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }))],
    [expandedPaths],
  );

  const directoryQueries = useQueries({
    queries: requestedPaths.map((directoryPath) => ({
      queryKey: queryKeys.worktrees.fileTree(worktreeId ?? "__missing__", directoryPath || undefined),
      queryFn: ({ signal }) =>
        api.getWorktreeDirectoryEntries(worktreeId!, directoryPath || undefined, signal),
      enabled: Boolean(worktreeId) && !pending,
      staleTime: 30_000,
    })),
  });
  const searchQuery = useQuery({
    queryKey: ["worktrees", worktreeId ?? "__missing__", "explorerSearch", searchTerm.trim()],
    queryFn: ({ signal }) => api.searchFiles(worktreeId!, searchTerm.trim(), signal),
    enabled: Boolean(worktreeId) && !pending && searchTerm.trim().length > 0,
    staleTime: 10_000,
  });

  const entriesByDirectory = useMemo(
    () => new Map(requestedPaths.map((directoryPath, index) => [directoryPath, directoryQueries[index]?.data ?? []])),
    [directoryQueries, requestedPaths],
  );
  const loadingPaths = useMemo(
    () => new Set(
      requestedPaths.filter((directoryPath, index) => {
        const query = directoryQueries[index];
        return Boolean(query && (query.isLoading || (query.isFetching && !query.data)));
      }),
    ),
    [directoryQueries, requestedPaths],
  );
  const errorByDirectory = useMemo(
    () => new Map(
      requestedPaths.flatMap((directoryPath, index) => {
        const error = directoryQueries[index]?.error;
        if (!error) {
          return [];
        }

        return [[directoryPath, error instanceof Error ? error.message : "Unable to load directory"] as const];
      }),
    ),
    [directoryQueries, requestedPaths],
  );

  const rootEntries = entriesByDirectory.get("") ?? [];
  const rootLoading = !pending && Boolean(worktreeId) && loadingPaths.has("");
  const rootError = pending ? null : (errorByDirectory.get("") ?? null);

  useEffect(() => {
    if (
      pending
      || !worktreeId
      || rootLoading
      || rootEntries.length === 0
      || initialExpansionAppliedRef.current === worktreeId
    ) {
      return;
    }

    initialExpansionAppliedRef.current = worktreeId;
    const matchingDefaultPaths = rootEntries
      .filter((entry) => entry.type === "directory" && DEFAULT_EXPANDED_ROOT_PATHS.includes(entry.path))
      .map((entry) => entry.path);

    if (matchingDefaultPaths.length === 0) {
      return;
    }

    startTransition(() => {
      setExpandedPaths((current) => mergeExpandedPaths(current, matchingDefaultPaths));
    });
  }, [pending, rootEntries, rootLoading, setExpandedPaths, worktreeId]);

  function toggleDirectory(path: string) {
    startTransition(() => {
      setExpandedPaths((current) => toggleExpandedPath(current, path));
    });
  }

  function renderNode(entry: ExplorerFileEntry, depth: number) {
    const isDirectory = entry.type === "directory";
    const isExpanded = isDirectory ? expandedPaths.has(entry.path) : false;
    const isActive = !isDirectory && activeFilePath === entry.path;
    const isSelected = actions.selectedEntry?.entry.path === entry.path;
    const changeCount = isDirectory ? (changeCountByDirectory.get(entry.path) ?? 0) : 0;
    const directoryLoading = isDirectory && isExpanded && loadingPaths.has(entry.path);
    const directoryError = isDirectory ? (errorByDirectory.get(entry.path) ?? null) : null;
    const children = isDirectory ? (entriesByDirectory.get(entry.path) ?? []) : [];
    const isDropTarget = isDirectory && actions.dropTargetPath === entry.path;

    if (actions.pendingInput?.mode === "rename" && actions.pendingInput.targetPath === entry.path) {
      return (
        <InlineExplorerInput
          key={entry.path}
          pendingInput={actions.pendingInput}
          onSubmit={actions.submitInput}
          onCancel={actions.cancelInput}
        />
      );
    }

    return (
      <div key={entry.path}>
        <button
          type="button"
          draggable
          data-explorer-path={!isDirectory ? entry.path : undefined}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40",
            (entry.sourceControlStatus === "untracked" || entry.sourceControlStatus === "ignored") && !isActive && "text-muted-foreground/55",
            isActive && "bg-secondary text-foreground",
            isSelected && !isActive && "bg-secondary/60 ring-1 ring-primary/30",
            isDropTarget && "bg-primary/10 ring-1 ring-primary/50",
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => {
            if (isDirectory) {
              toggleDirectory(entry.path);
              return;
            }
            onOpenFile(entry.path);
          }}
          onFocus={() => {
            actions.setSelectedEntry({ entry, depth });
          }}
          onContextMenu={(event) => actions.openMenu(event, entry)}
          onDragStart={(event) => {
            writeExplorerEntryDragData(event.dataTransfer, entry);
          }}
          onDragOver={isDirectory ? (event) => {
            if (hasExplorerEntryDragData(event.dataTransfer)) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
              actions.setDropTargetPath(entry.path);
            }
          } : undefined}
          onDragLeave={isDirectory ? () => {
            if (actions.dropTargetPath === entry.path) {
              actions.setDropTargetPath(null);
            }
          } : undefined}
          onDrop={isDirectory ? (event) => {
            event.preventDefault();
            event.stopPropagation();
            actions.setDropTargetPath(null);
            const dragData = readExplorerEntryDragData(event.dataTransfer);
            if (dragData) {
              void actions.handleDrop(entry.path, dragData, event.shiftKey ? "copy" : "move");
            }
          } : undefined}
        >
          {isDirectory ? (
            isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          <ExplorerNodeIcon
            manifest={iconManifest}
            path={entry.path}
            type={entry.type}
            isExpanded={isExpanded}
            depth={depth}
          />

          <span className="min-w-0 flex-1 truncate">{fileName(entry.path)}</span>

          {directoryLoading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/70" />
          ) : null}

          {isDirectory && changeCount > 0 ? (
            <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {changeCount}
            </span>
          ) : null}

          {!isDirectory && statusByPath.has(entry.path) ? (
            <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", changeDotClass(statusByPath.get(entry.path) ?? null))} />
          ) : null}
        </button>

        {isDirectory && isExpanded ? (
          <div>
            {actions.pendingInput?.parentPath === entry.path ? (
              <InlineExplorerInput
                pendingInput={actions.pendingInput}
                onSubmit={actions.submitInput}
                onCancel={actions.cancelInput}
              />
            ) : null}
            {children.map((child) => renderNode(child, depth + 1))}
            {directoryLoading && children.length === 0 ? (
              <div
                className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
                style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Loading…</span>
              </div>
            ) : null}
            {directoryError ? (
              <div
                className="px-2 py-1.5 text-xs text-destructive"
                style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
              >
                {directoryError}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderSearchResult(entry: ExplorerFileEntry) {
    const isDirectory = entry.type === "directory";
    return (
      <button
        key={entry.path}
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40",
          (entry.sourceControlStatus === "untracked" || entry.sourceControlStatus === "ignored") && "text-muted-foreground/55",
        )}
        onClick={() => {
          if (isDirectory) {
            setSearchTerm("");
            startTransition(() => {
              setExpandedPaths((current) => mergeExpandedPaths(current, parentDirectoryPaths(entry.path).concat(entry.path)));
            });
            return;
          }
          onOpenFile(entry.path);
        }}
        onContextMenu={(event) => actions.openMenu(event, entry)}
      >
        <ExplorerNodeIcon manifest={iconManifest} path={entry.path} type={entry.type} isExpanded={false} depth={0} />
        <span className="min-w-0 flex-1 truncate">{entry.path}</span>
      </button>
    );
  }

  return (
    <>
      <WorkspaceExplorerShell
        pending={pending}
        loading={searchTerm.trim() ? searchQuery.isLoading : rootLoading}
        empty={actions.pendingInput ? false : searchTerm.trim() ? (searchQuery.data ?? []).length === 0 : rootEntries.length === 0}
        error={searchTerm.trim()
          ? (searchQuery.error instanceof Error ? searchQuery.error.message : null)
          : rootError}
        onClose={onClose}
        scrollAreaRef={scrollAreaRef}
        showHeader={showHeader}
        toolbar={(
          <ExplorerToolbar
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            onNewFile={() => {
              setSearchTerm("");
              actions.beginCreateFile("", 0);
            }}
            onNewDirectory={() => {
              setSearchTerm("");
              actions.beginCreateDirectory("", 0);
            }}
            onCollapseAll={() => startTransition(() => setExpandedPaths(new Set()))}
            onRefresh={actions.refresh}
            error={actions.error}
            busy={actions.busy}
          />
        )}
        onRootContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            actions.openMenu(event, null);
          }
        }}
        onKeyDown={createExplorerKeyHandler(actions, canMutate)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            actions.setSelectedEntry(null);
          }
        }}
        onRootDragOver={(event) => {
          if (hasExplorerEntryDragData(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
            actions.setDropTargetPath("");
          }
        }}
        onRootDragLeave={() => {
          if (actions.dropTargetPath === "") {
            actions.setDropTargetPath(null);
          }
        }}
        onRootDrop={(event) => {
          event.preventDefault();
          actions.setDropTargetPath(null);
          const dragData = readExplorerEntryDragData(event.dataTransfer);
          if (dragData) {
            void actions.handleDrop("", dragData, event.shiftKey ? "copy" : "move");
          }
        }}
      >
        {searchTerm.trim()
          ? (searchQuery.data ?? []).map((entry) => renderSearchResult(entry))
          : (
              <>
                {actions.pendingInput?.parentPath === "" && actions.pendingInput.mode !== "rename" ? (
                  <InlineExplorerInput
                    pendingInput={actions.pendingInput}
                    onSubmit={actions.submitInput}
                    onCancel={actions.cancelInput}
                  />
                ) : null}
                {rootEntries.map((entry) => renderNode(entry, 0))}
              </>
            )}
      </WorkspaceExplorerShell>
      <ExplorerContextMenu menu={actions.menu} actions={actions} canMutate={canMutate} onTreeMutationStart={() => setSearchTerm("")} />
      <ExplorerDeleteDialog actions={actions} />
      <ExplorerOverwriteDialog actions={actions} />
    </>
  );
}

export function WorkspaceExplorerPanel(props: WorkspaceExplorerPanelProps) {
  if (props.entries !== undefined && typeof props.loading === "boolean") {
    return (
      <WorkspaceExplorerFlatContent
        worktreeId={props.worktreeId}
        entries={props.entries}
        gitEntries={props.gitEntries}
        pending={props.pending}
        loading={props.loading}
        activeFilePath={props.activeFilePath}
        onOpenFile={props.onOpenFile}
        onClose={props.onClose}
        showHeader={props.showHeader}
      />
    );
  }

  return (
      <WorkspaceExplorerPanelBridge
        worktreeId={props.worktreeId}
        gitEntries={props.gitEntries}
        pending={props.pending}
        activeFilePath={props.activeFilePath}
      onOpenFile={props.onOpenFile}
      onClose={props.onClose}
      showHeader={props.showHeader}
    />
  );
}
import { hasExplorerEntryDragData, readExplorerEntryDragData } from "./explorerDrag";
