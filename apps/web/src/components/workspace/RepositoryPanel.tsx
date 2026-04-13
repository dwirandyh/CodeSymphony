import {
  type DragEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueries } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  FolderGit2,
  GitBranch,
  GitPullRequestArrow,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  GitBranchDiffSummary,
  Repository,
  ReviewKind,
  ReviewRef,
} from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import { isRootWorktree } from "../../lib/worktree";
import { gitBranchDiffSummaryQueryOptions } from "../../hooks/queries/useGitBranchDiffSummary";
import { repositoryReviewsQueryOptions } from "../../hooks/queries/useRepositoryReviews";
import { useWorktreeStatuses } from "../../hooks/queries/useWorktreeStatuses";
import type {
  WorktreeStatusSummary,
  WorktreeThreadUiStatus,
} from "../../pages/workspace/hooks/worktreeThreadStatus";
import type { RepositoryPanelDropPosition } from "../../pages/workspace/repositoryPanelPreferences";

type RepositoryPanelProps = {
  repositories: Repository[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  hiddenRepositoryIds: string[];
  expandedByRepo: Record<string, boolean>;
  loadingRepos: boolean;
  submittingRepo: boolean;
  submittingWorktree: boolean;
  onAttachRepository: () => void;
  onSelectRepository: (repositoryId: string) => void;
  onToggleRepositoryExpand: (
    repositoryId: string,
    nextExpanded: boolean,
  ) => void;
  onSetRepositoryVisibility: (repositoryId: string, visible: boolean) => void;
  onShowAllRepositories: () => void;
  onReorderRepositories: (
    draggedRepositoryId: string,
    targetRepositoryId: string,
    position: RepositoryPanelDropPosition,
  ) => void;
  onCreateWorktree: (repositoryId: string) => void;
  onSelectWorktree: (
    repositoryId: string,
    worktreeId: string,
    preferredThreadId?: string | null,
  ) => void;
  onDeleteWorktree: (worktreeId: string) => void;
  onRenameWorktreeBranch: (worktreeId: string, newBranch: string) => void;
};

const WORKTREE_STATUS_META: Record<
  Exclude<WorktreeThreadUiStatus, "idle" | "running">,
  { label: string; variant: "secondary" | "destructive" }
> = {
  waiting_approval: { label: "Waiting approval", variant: "destructive" },
  review_plan: { label: "Review plan", variant: "secondary" },
};

const REVIEW_STATE_META: Record<
  ReviewRef["state"],
  { label: string; className: string }
> = {
  open: {
    label: "Open",
    className: "text-emerald-600 dark:text-emerald-300",
  },
  merged: {
    label: "Merged",
    className: "text-indigo-600 dark:text-indigo-300",
  },
  closed: {
    label: "Closed",
    className: "text-rose-600 dark:text-rose-300",
  },
};

function resolvePriorityThreadId(
  status: WorktreeStatusSummary | undefined,
): string | null {
  if (!status?.threadId) {
    return null;
  }

  return status.kind === "waiting_approval" || status.kind === "review_plan"
    ? status.threadId
    : null;
}

function WorktreeStatusBadge({
  status,
}: {
  status: WorktreeThreadUiStatus | undefined;
}) {
  if (!status || status === "idle") {
    return null;
  }

  if (status === "running") {
    return (
      <div
        className="pointer-events-none flex h-4 w-4 items-center justify-center"
        data-testid="worktree-status-running"
        aria-label="Running"
        title="Running"
      >
        <span className="relative flex h-2 w-2">
          <span
            className="absolute inset-0 inline-flex animate-ping rounded-full bg-sky-500/75"
            aria-hidden="true"
          />
          <span
            className="relative inline-flex h-2 w-2 rounded-full bg-sky-500"
            aria-hidden="true"
          />
        </span>
      </div>
    );
  }

  const meta = WORKTREE_STATUS_META[status];
  return (
    <Badge
      variant={meta.variant}
      className="pointer-events-none h-3.5 rounded-md px-1 py-0 text-[9px] leading-none shadow-sm"
      data-testid={`worktree-status-${status}`}
    >
      {meta.label}
    </Badge>
  );
}

function WorktreeReviewBadge({
  review,
  kind,
  testId,
}: {
  review: ReviewRef | null;
  kind: ReviewKind | null | undefined;
  testId: string;
}) {
  if (!review) {
    return null;
  }

  const meta = REVIEW_STATE_META[review.state];
  const reviewLabel = review.display;
  const reviewTitleLabel = `${kind === "mr" ? "MR" : "PR"} ${review.display}`;

  return (
    <div
      className={cn(
        "pointer-events-none inline-flex h-3 translate-y-px items-center gap-0.5 text-[10px] leading-none",
        meta.className,
      )}
      data-testid={`${testId}-review`}
      title={`${meta.label} ${reviewTitleLabel}`}
    >
      <GitPullRequestArrow className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="leading-none">{reviewLabel}</span>
    </div>
  );
}

function WorktreeDiffSummary({
  insertions,
  deletions,
  testId,
}: {
  insertions: number;
  deletions: number;
  testId: string;
}) {
  if (insertions <= 0 && deletions <= 0) {
    return null;
  }

  return (
    <div
      className="flex h-3 shrink-0 items-center gap-1 text-[10px] leading-none"
      data-testid={`${testId}-diff`}
    >
      <span className="leading-none text-green-500">+{insertions}</span>
      <span className="leading-none text-red-500">-{deletions}</span>
    </div>
  );
}

function WorktreeMetaSlot({
  hiddenOnHover,
  children,
}: {
  hiddenOnHover?: boolean;
  children: ReactNode;
}) {
  if (!children) {
    return null;
  }

  return (
    <div
      className={cn(
        "shrink-0",
        hiddenOnHover &&
          "transition-opacity group-hover/wt:pointer-events-none group-hover/wt:opacity-0 group-focus-within/wt:pointer-events-none group-focus-within/wt:opacity-0",
      )}
    >
      {children}
    </div>
  );
}

function WorktreeRowContent({
  icon,
  branchContent,
  status,
  review,
  reviewKind,
  insertions,
  deletions,
  testId,
  hideStatusOnHover = false,
}: {
  icon: ReactNode;
  branchContent: ReactNode;
  status: WorktreeThreadUiStatus | undefined;
  review: ReviewRef | null;
  reviewKind: ReviewKind | null | undefined;
  insertions: number;
  deletions: number;
  testId: string;
  hideStatusOnHover?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {icon}
          {branchContent}
        </div>
        <WorktreeMetaSlot hiddenOnHover={hideStatusOnHover}>
          <WorktreeStatusBadge status={status} />
        </WorktreeMetaSlot>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-5 pt-0.5">
        <WorktreeMetaSlot>
          <WorktreeReviewBadge
            review={review}
            kind={reviewKind}
            testId={testId}
          />
        </WorktreeMetaSlot>
        <WorktreeMetaSlot>
          <WorktreeDiffSummary
            insertions={insertions}
            deletions={deletions}
            testId={testId}
          />
        </WorktreeMetaSlot>
      </div>
    </div>
  );
}

export function RepositoryPanel({
  repositories,
  selectedRepositoryId,
  selectedWorktreeId,
  hiddenRepositoryIds,
  expandedByRepo,
  loadingRepos,
  submittingRepo,
  submittingWorktree,
  onAttachRepository,
  onSelectRepository,
  onToggleRepositoryExpand,
  onSetRepositoryVisibility,
  onShowAllRepositories,
  onReorderRepositories,
  onCreateWorktree,
  onSelectWorktree,
  onDeleteWorktree,
  onRenameWorktreeBranch,
}: RepositoryPanelProps) {
  const [editingWorktreeId, setEditingWorktreeId] = useState<string | null>(
    null,
  );
  const [editingBranchValue, setEditingBranchValue] = useState("");
  const [draggedRepositoryId, setDraggedRepositoryId] = useState<string | null>(
    null,
  );
  const draggedRepositoryIdRef = useRef<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    repositoryId: string;
    position: RepositoryPanelDropPosition;
  } | null>(null);

  const hiddenRepositoryIdSet = useMemo(
    () => new Set(hiddenRepositoryIds),
    [hiddenRepositoryIds],
  );
  const visibleRepositories = useMemo(
    () =>
      repositories.filter(
        (repository) => !hiddenRepositoryIdSet.has(repository.id),
      ),
    [hiddenRepositoryIdSet, repositories],
  );
  const hiddenRepositoryCount =
    repositories.length - visibleRepositories.length;

  const activeWorktreeSummaries = useMemo(
    () =>
      repositories.flatMap((repository) =>
        repository.worktrees
          .filter((worktree) => worktree.status === "active")
          .map((worktree) => ({
            worktreeId: worktree.id,
            baseBranch: worktree.baseBranch || repository.defaultBranch,
          })),
      ),
    [repositories],
  );
  const worktreeStatuses = useWorktreeStatuses(repositories);
  const gitBranchDiffQueries = useQueries({
    queries: activeWorktreeSummaries.map(({ worktreeId, baseBranch }) =>
      gitBranchDiffSummaryQueryOptions(worktreeId, baseBranch),
    ),
  });
  const repositoryReviewQueries = useQueries({
    queries: repositories.map((repository) =>
      repositoryReviewsQueryOptions(repository.id),
    ),
  });
  const reviewsByRepositoryId = useMemo(
    () =>
      Object.fromEntries(
        repositories.map((repository, index) => [
          repository.id,
          repositoryReviewQueries[index]?.data?.reviewsByBranch ?? {},
        ]),
      ) as Record<string, Record<string, ReviewRef>>,
    [repositories, repositoryReviewQueries],
  );
  const reviewKindsByRepositoryId = useMemo(
    () =>
      Object.fromEntries(
        repositories.map((repository, index) => [
          repository.id,
          repositoryReviewQueries[index]?.data?.kind ?? null,
        ]),
      ) as Record<string, ReviewKind | null>,
    [repositories, repositoryReviewQueries],
  );
  const worktreeStats = useMemo(() => {
    return activeWorktreeSummaries.reduce<Record<string, GitBranchDiffSummary>>(
      (acc, { worktreeId }, index) => {
        const summary = gitBranchDiffQueries[index]?.data as
          | GitBranchDiffSummary
          | undefined;
        if (!summary?.available) {
          return acc;
        }
        acc[worktreeId] = summary;
        return acc;
      },
      {},
    );
  }, [activeWorktreeSummaries, gitBranchDiffQueries]);

  function toggleRepository(repositoryId: string) {
    const nextExpanded = !(
      expandedByRepo[repositoryId] ?? selectedRepositoryId === repositoryId
    );
    onToggleRepositoryExpand(repositoryId, nextExpanded);
    onSelectRepository(repositoryId);
  }

  function resolveDropPosition(
    event: DragEvent<HTMLElement>,
  ): RepositoryPanelDropPosition {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before";
  }

  function resolveDraggedRepositoryId(
    event: Pick<DragEvent<HTMLElement>, "dataTransfer"> | null,
  ): string | null {
    if (draggedRepositoryIdRef.current) {
      return draggedRepositoryIdRef.current;
    }

    const dataTransfer = event?.dataTransfer;
    if (!dataTransfer) {
      return null;
    }

    try {
      const repositoryId = dataTransfer.getData("text/plain").trim();
      return repositoryId || null;
    } catch {
      return null;
    }
  }

  function handleRepositoryDragStart(
    event: DragEvent<HTMLElement>,
    repositoryId: string,
  ) {
    draggedRepositoryIdRef.current = repositoryId;
    setDraggedRepositoryId(repositoryId);
    setDropIndicator(null);

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", repositoryId);
    }
  }

  function handleRepositoryDragOver(
    event: DragEvent<HTMLElement>,
    repositoryId: string,
  ) {
    const sourceRepositoryId = resolveDraggedRepositoryId(event);
    if (!sourceRepositoryId || sourceRepositoryId === repositoryId) {
      return;
    }

    event.preventDefault();
    const position = resolveDropPosition(event);
    setDropIndicator({ repositoryId, position });

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  function handleRepositoryDrop(
    event: DragEvent<HTMLElement>,
    repositoryId: string,
  ) {
    event.preventDefault();

    const sourceRepositoryId = resolveDraggedRepositoryId(event);
    const position = resolveDropPosition(event);

    if (sourceRepositoryId && sourceRepositoryId !== repositoryId) {
      onReorderRepositories(sourceRepositoryId, repositoryId, position);
    }

    clearDragState();
  }

  function clearDragState() {
    draggedRepositoryIdRef.current = null;
    setDraggedRepositoryId(null);
    setDropIndicator(null);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5">
        <h2 className="text-xs font-medium tracking-[0.03em] text-muted-foreground">
          Workspace (
          {hiddenRepositoryCount > 0
            ? `${visibleRepositories.length}/${repositories.length}`
            : repositories.length}
          )
        </h2>
        <div className="flex items-center gap-0.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Filter workspaces"
                title="Filter workspaces"
                disabled={repositories.length === 0}
                className="relative h-7 w-7 text-muted-foreground hover:text-foreground"
              >
                <Filter className="h-3.5 w-3.5" />
                {hiddenRepositoryCount > 0 ? (
                  <span
                    className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[220px] p-1">
              <div className="flex items-center justify-between gap-2 px-1 py-0.5">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Visible
                </div>
                <button
                  type="button"
                  className="text-[11px] font-medium text-primary disabled:text-muted-foreground"
                  disabled={hiddenRepositoryCount === 0}
                  onClick={onShowAllRepositories}
                >
                  All
                </button>
              </div>
              <div className="mt-1 space-y-px">
                {repositories.map((repository) => {
                  const visible = !hiddenRepositoryIdSet.has(repository.id);

                  return (
                    <label
                      key={repository.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-secondary/60"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-border"
                        checked={visible}
                        onChange={(event) =>
                          onSetRepositoryVisibility(
                            repository.id,
                            event.currentTarget.checked,
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {repository.name}
                      </span>
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Attach repository"
            title="Attach repository"
            disabled={submittingRepo}
            onClick={onAttachRepository}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {loadingRepos ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">
          Loading repositories...
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1 px-1 pb-1">
        {repositories.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No repositories added yet.
          </div>
        ) : null}

        {repositories.length > 0 && visibleRepositories.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No workspaces selected in the filter.
          </div>
        ) : null}

        <div className="space-y-0.5">
          {visibleRepositories.map((repository) => {
            const isSelected = selectedRepositoryId === repository.id;
            const activeWorktrees = repository.worktrees.filter(
              (worktree) => worktree.status === "active",
            );
            const rootWorkspace =
              activeWorktrees.find((worktree) =>
                isRootWorktree(worktree, repository),
              ) ?? null;
            const branchWorktrees = rootWorkspace
              ? activeWorktrees.filter(
                  (worktree) => worktree.id !== rootWorkspace.id,
                )
              : activeWorktrees;
            const isExpanded = expandedByRepo[repository.id] ?? isSelected;
            const rootPriorityThreadId = rootWorkspace
              ? resolvePriorityThreadId(worktreeStatuses[rootWorkspace.id])
              : null;
            const repositoryReviews =
              reviewsByRepositoryId[repository.id] ?? {};
            const repositoryReviewKind =
              reviewKindsByRepositoryId[repository.id] ?? null;

            return (
              <article
                key={repository.id}
                className={cn(
                  "min-w-0 rounded-md p-0.5",
                  isSelected && "text-foreground",
                  draggedRepositoryId === repository.id && "opacity-60",
                  dropIndicator?.repositoryId === repository.id &&
                    dropIndicator.position === "before" &&
                    "border-t border-primary",
                  dropIndicator?.repositoryId === repository.id &&
                    dropIndicator.position === "after" &&
                    "border-b border-primary",
                )}
                data-testid={`repository-${repository.id}`}
                onDragOver={(event) =>
                  handleRepositoryDragOver(event, repository.id)
                }
                onDrop={(event) => handleRepositoryDrop(event, repository.id)}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    draggable={repositories.length > 1}
                    className={cn(
                      "h-8 min-w-0 flex-1 cursor-grab justify-start gap-1.5 overflow-hidden px-2 text-muted-foreground hover:text-foreground active:cursor-grabbing",
                      isSelected && "text-foreground",
                    )}
                    onClick={() => toggleRepository(repository.id)}
                    onDragStart={(event) =>
                      handleRepositoryDragStart(event, repository.id)
                    }
                    onDragEnd={clearDragState}
                    title={`${repository.name}${repositories.length > 1 ? " · drag to reorder" : ""}`}
                  >
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {isExpanded ? (
                        <ChevronDown
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : (
                        <ChevronRight
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="truncate text-left text-xs font-medium">
                      {repository.name}
                    </span>
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Add worktree for ${repository.name}`}
                    title={`Create worktree from ${repository.defaultBranch}`}
                    disabled={submittingWorktree}
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      onSelectRepository(repository.id);
                      onCreateWorktree(repository.id);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {isExpanded ? (
                  <div className="ml-4 mt-1 min-w-0 space-y-1">
                    {!rootWorkspace && branchWorktrees.length === 0 ? (
                      <div className="flex items-center gap-2 py-1">
                        <div className="text-xs text-muted-foreground">
                          No active worktrees yet.
                        </div>
                      </div>
                    ) : null}

                    {rootWorkspace ? (
                      <div className="space-y-1">
                        <div className="group/wt relative">
                          <button
                            type="button"
                            className={cn(
                              "flex w-full min-w-0 items-start gap-2 overflow-hidden rounded-md px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-secondary/40",
                              selectedWorktreeId === rootWorkspace.id &&
                                "bg-secondary/60 text-foreground",
                            )}
                            onClick={() =>
                              onSelectWorktree(
                                repository.id,
                                rootWorkspace.id,
                                rootPriorityThreadId,
                              )
                            }
                          >
                            <WorktreeRowContent
                              icon={
                                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                  <FolderGit2
                                    className="h-3.5 w-3.5 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                </span>
                              }
                              branchContent={
                                <span className="truncate text-xs">
                                  {rootWorkspace.branch}
                                </span>
                              }
                              status={worktreeStatuses[rootWorkspace.id]?.kind}
                              review={
                                repositoryReviews[rootWorkspace.branch] ?? null
                              }
                              reviewKind={repositoryReviewKind}
                              insertions={
                                worktreeStats[rootWorkspace.id]?.insertions ?? 0
                              }
                              deletions={
                                worktreeStats[rootWorkspace.id]?.deletions ?? 0
                              }
                              testId={`worktree-${rootWorkspace.id}`}
                            />
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {branchWorktrees.length > 0 ? (
                      <div className="space-y-1">
                        {branchWorktrees.map((worktree) => {
                          const isWorktreeSelected =
                            selectedWorktreeId === worktree.id;
                          const stats = worktreeStats[worktree.id];
                          const priorityThreadId = resolvePriorityThreadId(
                            worktreeStatuses[worktree.id],
                          );
                          const review =
                            repositoryReviews[worktree.branch] ?? null;

                          return (
                            <div
                              key={worktree.id}
                              className="group/wt relative"
                            >
                              <div
                                role="button"
                                tabIndex={0}
                                data-worktree-id={worktree.id}
                                className={cn(
                                  "flex w-full min-w-0 cursor-pointer items-start gap-1.5 overflow-hidden rounded-md px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                                  isWorktreeSelected &&
                                    "bg-secondary/60 text-foreground",
                                )}
                                onClick={() =>
                                  onSelectWorktree(
                                    repository.id,
                                    worktree.id,
                                    priorityThreadId,
                                  )
                                }
                                onKeyDown={(e) => {
                                  if (e.target !== e.currentTarget) {
                                    return;
                                  }
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelectWorktree(
                                      repository.id,
                                      worktree.id,
                                      priorityThreadId,
                                    );
                                  }
                                }}
                              >
                                <WorktreeRowContent
                                  icon={
                                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                      <GitBranch
                                        className="h-3.5 w-3.5 text-muted-foreground"
                                        aria-hidden="true"
                                      />
                                    </span>
                                  }
                                  branchContent={
                                    editingWorktreeId === worktree.id ? (
                                      <input
                                        type="text"
                                        className="min-w-0 flex-1 rounded border border-input bg-background px-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                                        value={editingBranchValue}
                                        autoFocus
                                        onChange={(e) =>
                                          setEditingBranchValue(e.target.value)
                                        }
                                        onClick={(e) => e.stopPropagation()}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            const trimmed =
                                              editingBranchValue.trim();
                                            if (
                                              trimmed &&
                                              trimmed !== worktree.branch
                                            ) {
                                              onRenameWorktreeBranch(
                                                worktree.id,
                                                trimmed,
                                              );
                                            }
                                            setEditingWorktreeId(null);
                                          }
                                          if (e.key === "Escape") {
                                            setEditingWorktreeId(null);
                                          }
                                        }}
                                        onBlur={() => {
                                          const trimmed =
                                            editingBranchValue.trim();
                                          if (
                                            trimmed &&
                                            trimmed !== worktree.branch
                                          ) {
                                            onRenameWorktreeBranch(
                                              worktree.id,
                                              trimmed,
                                            );
                                          }
                                          setEditingWorktreeId(null);
                                        }}
                                      />
                                    ) : (
                                      <span
                                        className="truncate text-xs"
                                        onDoubleClick={(e) => {
                                          e.stopPropagation();
                                          setEditingWorktreeId(worktree.id);
                                          setEditingBranchValue(
                                            worktree.branch,
                                          );
                                        }}
                                      >
                                        {worktree.branch}
                                      </span>
                                    )
                                  }
                                  status={worktreeStatuses[worktree.id]?.kind}
                                  review={review}
                                  reviewKind={repositoryReviewKind}
                                  insertions={stats?.insertions ?? 0}
                                  deletions={stats?.deletions ?? 0}
                                  testId={`worktree-${worktree.id}`}
                                  hideStatusOnHover={true}
                                />
                              </div>

                              <div className="pointer-events-none absolute top-0 right-2 bottom-0 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/wt:pointer-events-auto group-hover/wt:opacity-100 group-focus-within/wt:pointer-events-auto group-focus-within/wt:opacity-100">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingWorktreeId(worktree.id);
                                    setEditingBranchValue(worktree.branch);
                                  }}
                                  title="Rename branch"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteWorktree(worktree.id);
                                  }}
                                  title="Delete worktree"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </ScrollArea>
    </section>
  );
}
