import type { CliAgent } from "@codesymphony/shared-types";

export const queryKeys = {
  repositories: {
    all: ["repositories"] as const,
    branches: (repositoryId: string) => ["repositories", repositoryId, "branches"] as const,
    reviews: (repositoryId: string) => ["repositories", repositoryId, "reviews"] as const,
  },
  worktrees: {
    gitStatus: (worktreeId: string) => ["worktrees", worktreeId, "gitStatus"] as const,
    gitBranchDiffSummary: (worktreeId: string, baseBranch: string) =>
      ["worktrees", worktreeId, "gitBranchDiffSummary", baseBranch] as const,
    gitDiffScope: (worktreeId: string) => ["worktrees", worktreeId, "gitDiff"] as const,
    gitDiff: (worktreeId: string, filePath?: string) =>
      ["worktrees", worktreeId, "gitDiff", filePath ?? "__all__"] as const,
    gitDiffRaw: (worktreeId: string, filePath?: string) =>
      ["worktrees", worktreeId, "gitDiffRaw", filePath ?? "__all__"] as const,
    fileIndex: (worktreeId: string) => ["worktrees", worktreeId, "fileIndex"] as const,
    slashCommands: (worktreeId: string, agent: CliAgent) => ["worktrees", worktreeId, "slashCommands", agent] as const,
    fileContents: (worktreeId: string, filePath: string) =>
      ["worktrees", worktreeId, "fileContents", filePath] as const,
  },
  threads: {
    list: (worktreeId: string) => ["threads", "list", worktreeId] as const,
    timelineSnapshot: (threadId: string) => ["threads", threadId, "timelineSnapshot"] as const,
    statusSnapshot: (threadId: string) => ["threads", threadId, "statusSnapshot"] as const,
    messages: (threadId: string) => ["threads", threadId, "messages"] as const,
    events: (threadId: string) => ["threads", threadId, "events"] as const,
  },
  filesystem: {
    browse: (path?: string) => ["filesystem", "browse", path ?? "__root__"] as const,
  },
  models: {
    cursorCatalog: ["models", "cursor", "catalog"] as const,
    opencodeCatalog: ["models", "opencode", "catalog"] as const,
  },
  runtime: {
    info: ["runtime", "info"] as const,
  },
  system: {
    installedApps: ["system", "installedApps"] as const,
  },
};
