export const queryKeys = {
  repositories: {
    all: ["repositories"] as const,
    reviews: (repositoryId: string) => ["repositories", repositoryId, "reviews"] as const,
  },
  worktrees: {
    gitStatus: (worktreeId: string) => ["worktrees", worktreeId, "gitStatus"] as const,
    gitBranchDiffSummary: (worktreeId: string, baseBranch: string) =>
      ["worktrees", worktreeId, "gitBranchDiffSummary", baseBranch] as const,
    gitDiff: (worktreeId: string, filePath?: string) =>
      ["worktrees", worktreeId, "gitDiff", filePath ?? "__all__"] as const,
    fileIndex: (worktreeId: string) => ["worktrees", worktreeId, "fileIndex"] as const,
    fileContents: (worktreeId: string, filePath: string) =>
      ["worktrees", worktreeId, "fileContents", filePath] as const,
  },
  threads: {
    list: (worktreeId: string) => ["threads", "list", worktreeId] as const,
    timelineSnapshot: (threadId: string) => ["threads", threadId, "timelineSnapshot"] as const,
    statusSnapshot: (threadId: string) => ["threads", threadId, "statusSnapshot"] as const,
    commands: (threadId: string) => ["threads", threadId, "commands"] as const,
    messages: (threadId: string) => ["threads", threadId, "messages"] as const,
    events: (threadId: string) => ["threads", threadId, "events"] as const,
  },
  filesystem: {
    browse: (path?: string) => ["filesystem", "browse", path ?? "__root__"] as const,
  },
  system: {
    installedApps: ["system", "installedApps"] as const,
  },
};
