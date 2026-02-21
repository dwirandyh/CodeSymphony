import { z } from "zod";

export const WorktreeStatusSchema = z.enum(["active", "archived"]);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatEventTypeSchema = z.enum([
  "message.delta",
  "thinking.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "permission.resolved",
  "question.requested",
  "question.answered",
  "plan.created",
  "plan.approved",
  "plan.revision_requested",
  "subagent.started",
  "subagent.finished",
  "chat.completed",
  "chat.failed",
]);
export type ChatEventType = z.infer<typeof ChatEventTypeSchema>;

export const WorktreeSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  branch: z.string().min(1),
  path: z.string().min(1),
  baseBranch: z.string().min(1),
  status: WorktreeStatusSchema,
  branchRenamed: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const RepositorySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  worktrees: z.array(WorktreeSchema),
});

export const ChatThreadSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  title: z.string().min(1),
  claudeSessionId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number().int().nonnegative(),
  role: ChatRoleSchema,
  content: z.string(),
  createdAt: z.string().datetime(),
});

export const ChatEventSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  idx: z.number().int().nonnegative(),
  type: ChatEventTypeSchema,
  payload: z.record(z.string(), z.any()),
  createdAt: z.string().datetime(),
});

export const CreateRepositoryInputSchema = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});

export const CreateWorktreeInputSchema = z.object({
  branch: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
});

export const CreateChatThreadInputSchema = z.object({
  title: z.string().trim().min(1).optional(),
});

export const ChatModeSchema = z.enum(["default", "plan"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

export const SendChatMessageInputSchema = z.object({
  content: z.string().trim().min(1),
  mode: ChatModeSchema.optional().default("default"),
});

export const PermissionDecisionSchema = z.enum(["allow", "allow_always", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const ResolvePermissionInputSchema = z.object({
  requestId: z.string().trim().min(1),
  decision: PermissionDecisionSchema,
});
export type ResolvePermissionInput = z.infer<typeof ResolvePermissionInputSchema>;

export const AnswerQuestionInputSchema = z.object({
  requestId: z.string().trim().min(1),
  answers: z.record(z.string(), z.string()),
});
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInputSchema>;

export const PlanRevisionInputSchema = z.object({
  feedback: z.string().trim().min(1),
});
export type PlanRevisionInput = z.infer<typeof PlanRevisionInputSchema>;

export const OpenWorktreeFileInputSchema = z.object({
  path: z.string().trim().min(1),
});
export type OpenWorktreeFileInput = z.infer<typeof OpenWorktreeFileInputSchema>;

export const RenameWorktreeBranchInputSchema = z.object({
  branch: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((val) => /^[a-zA-Z0-9._\-/]+$/.test(val), {
      message:
        "Branch name must contain only alphanumeric characters, dots, hyphens, underscores, and slashes",
    }),
});
export type RenameWorktreeBranchInput = z.infer<typeof RenameWorktreeBranchInputSchema>;

export type Repository = z.infer<typeof RepositorySchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type CreateRepositoryInput = z.infer<typeof CreateRepositoryInputSchema>;
export type CreateWorktreeInput = z.infer<typeof CreateWorktreeInputSchema>;
export type CreateChatThreadInput = z.infer<typeof CreateChatThreadInputSchema>;
export type SendChatMessageInput = z.infer<typeof SendChatMessageInputSchema>;

export const FileEntrySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory"]),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

// ── Git Types ──

export const GitChangeStatusSchema = z.enum(["modified", "added", "deleted", "renamed", "untracked"]);
export type GitChangeStatus = z.infer<typeof GitChangeStatusSchema>;

export const GitChangeEntrySchema = z.object({
  path: z.string(),
  status: GitChangeStatusSchema,
  insertions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});
export type GitChangeEntry = z.infer<typeof GitChangeEntrySchema>;

export const GitStatusSchema = z.object({
  branch: z.string(),
  entries: z.array(GitChangeEntrySchema),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const GitCommitInputSchema = z.object({
  message: z.string().trim().optional().default(""),
});
export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;

export const GitDiffSchema = z.object({
  diff: z.string(),
  summary: z.string(),
});
export type GitDiff = z.infer<typeof GitDiffSchema>;

// ── Filesystem Browse Types ──

export const FilesystemEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["directory", "symlink"]),
  isGitRepo: z.boolean(),
});
export type FilesystemEntry = z.infer<typeof FilesystemEntrySchema>;

export const FilesystemBrowseQuerySchema = z.object({
  path: z.string().optional(),
});
export type FilesystemBrowseQuery = z.infer<typeof FilesystemBrowseQuerySchema>;

export const FilesystemBrowseResponseSchema = z.object({
  currentPath: z.string(),
  parentPath: z.string().nullable(),
  entries: z.array(FilesystemEntrySchema),
});
export type FilesystemBrowseResponse = z.infer<typeof FilesystemBrowseResponseSchema>;
