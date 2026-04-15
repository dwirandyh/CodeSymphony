import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, Loader2, X } from "lucide-react";
import type { FileEntry, GitChangeEntry, GitChangeStatus } from "@codesymphony/shared-types";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

type ExplorerNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children: ExplorerNode[];
  changeCount: number;
  status: GitChangeStatus | null;
};

function insertNode(root: ExplorerNode, entry: FileEntry, statusByPath: Map<string, GitChangeStatus>) {
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

function buildTree(entries: FileEntry[], gitEntries: GitChangeEntry[]): ExplorerNode {
  const root: ExplorerNode = {
    name: "",
    path: "",
    type: "directory",
    children: [],
    changeCount: 0,
    status: null,
  };
  const statusByPath = new Map(gitEntries.map((entry) => [entry.path, entry.status] as const));

  for (const entry of entries) {
    insertNode(root, entry, statusByPath);
  }

  return sortTree(root);
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

interface WorkspaceExplorerPanelProps {
  entries: FileEntry[];
  gitEntries: GitChangeEntry[];
  loading: boolean;
  activeFilePath: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

export function WorkspaceExplorerPanel({
  entries,
  gitEntries,
  loading,
  activeFilePath,
  onOpenFile,
  onClose,
}: WorkspaceExplorerPanelProps) {
  const tree = useMemo(() => buildTree(entries, gitEntries), [entries, gitEntries]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["src", "app", "apps", "packages"]));

  function toggleDirectory(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderNode(node: ExplorerNode, depth: number) {
    const isDirectory = node.type === "directory";
    const isExpanded = isDirectory ? expandedPaths.has(node.path) : false;
    const isActive = !isDirectory && activeFilePath === node.path;
    const directoryChanged = isDirectory && node.changeCount > 0;

    return (
      <div key={node.path || "__root__"}>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40",
            isActive && "bg-secondary text-foreground",
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => {
            if (isDirectory) {
              toggleDirectory(node.path);
              return;
            }
            onOpenFile(node.path);
          }}
        >
          {isDirectory ? (
            isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          {isDirectory ? (
            isExpanded ? <FolderOpen className="h-4 w-4 shrink-0 text-sky-500" /> : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}

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
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="flex h-full flex-col overflow-hidden border-l border-border/40 bg-background">
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

      <ScrollArea className="min-h-0 flex-1 px-2 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : tree.children.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            No files available for this worktree.
          </div>
        ) : (
          <div className="space-y-0.5">
            {tree.children.map((node) => renderNode(node, 0))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}
