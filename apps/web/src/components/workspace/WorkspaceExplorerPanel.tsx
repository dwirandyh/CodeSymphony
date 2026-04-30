import { startTransition, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, Loader2, X } from "lucide-react";
import type { FileEntry, GitChangeEntry, GitChangeStatus } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import {
  loadMaterialIconThemeManifest,
  resolveMaterialIconThemeIconUrl,
  type MaterialIconThemeManifest,
} from "../../lib/materialIconTheme";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

const DEFAULT_EXPANDED_ROOT_PATHS = ["src", "app", "apps", "packages"];
const PENDING_EXPLORER_SKELETON_WIDTHS = ["58%", "72%", "46%", "67%", "54%", "61%", "39%"];

type ExplorerNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children: ExplorerNode[];
  changeCount: number;
  status: GitChangeStatus | null;
};

function fileName(filePath: string): string {
  const parts = filePath.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? filePath;
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

    startTransition(() => {
      setExpandedPaths((current) => mergeExpandedPaths(current, pathsToExpand));
    });
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
  showHeader = true,
  children,
}: {
  pending: boolean;
  loading: boolean;
  empty: boolean;
  error: string | null;
  onClose: () => void;
  scrollAreaRef: RefObject<HTMLDivElement | null>;
  showHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn(
      "flex h-full flex-col overflow-hidden bg-background",
      showHeader && "border-l border-border/40",
    )}>
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

      <ScrollArea ref={scrollAreaRef} className={cn("min-h-0 flex-1 px-2 py-2", !showHeader && "pb-4")}>
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

function WorkspaceExplorerFlatContent({
  gitEntries,
  entries,
  pending = false,
  loading,
  activeFilePath,
  onOpenFile,
  onClose,
  showHeader = true,
}: {
  entries: FileEntry[];
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

    return (
      <div key={node.path || "__root__"}>
        <button
          type="button"
          data-explorer-path={!isDirectory ? node.path : undefined}
          aria-current={isActive ? "page" : undefined}
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
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <WorkspaceExplorerShell
      pending={pending}
      loading={loading}
      empty={tree.children.length === 0}
      error={null}
      onClose={onClose}
      scrollAreaRef={scrollAreaRef}
      showHeader={showHeader}
    >
      {tree.children.map((node) => renderNode(node, 0))}
    </WorkspaceExplorerShell>
  );
}

interface WorkspaceExplorerPanelProps {
  worktreeId?: string | null;
  gitEntries: GitChangeEntry[];
  entries?: FileEntry[];
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
  const initialExpansionAppliedRef = useRef<string | null>(null);
  const { statusByPath, changeCountByDirectory } = useMemo(() => buildGitDecorations(gitEntries), [gitEntries]);

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

  function renderNode(entry: FileEntry, depth: number) {
    const isDirectory = entry.type === "directory";
    const isExpanded = isDirectory ? expandedPaths.has(entry.path) : false;
    const isActive = !isDirectory && activeFilePath === entry.path;
    const changeCount = isDirectory ? (changeCountByDirectory.get(entry.path) ?? 0) : 0;
    const directoryLoading = isDirectory && isExpanded && loadingPaths.has(entry.path);
    const directoryError = isDirectory ? (errorByDirectory.get(entry.path) ?? null) : null;
    const children = isDirectory ? (entriesByDirectory.get(entry.path) ?? []) : [];

    return (
      <div key={entry.path}>
        <button
          type="button"
          data-explorer-path={!isDirectory ? entry.path : undefined}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40",
            isActive && "bg-secondary text-foreground",
          )}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => {
            if (isDirectory) {
              toggleDirectory(entry.path);
              return;
            }
            onOpenFile(entry.path);
          }}
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

  return (
    <WorkspaceExplorerShell
      pending={pending}
      loading={rootLoading}
      empty={rootEntries.length === 0}
      error={rootError}
      onClose={onClose}
      scrollAreaRef={scrollAreaRef}
      showHeader={showHeader}
    >
      {rootEntries.map((entry) => renderNode(entry, 0))}
    </WorkspaceExplorerShell>
  );
}

export function WorkspaceExplorerPanel(props: WorkspaceExplorerPanelProps) {
  if (props.entries !== undefined && typeof props.loading === "boolean") {
    return (
      <WorkspaceExplorerFlatContent
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
