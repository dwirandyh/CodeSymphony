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
  "question.dismissed",
  "plan.created",
  "plan.approved",
  "plan.dismissed",
  "plan.revision_requested",
  "commands.updated",
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
  setupScript: z.array(z.string()).nullable().optional(),
  teardownScript: z.array(z.string()).nullable().optional(),
  runScript: z.array(z.string()).nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  worktrees: z.array(WorktreeSchema),
});

export const ChatThreadKindSchema = z.enum(["default", "review"]);
export type ChatThreadKind = z.infer<typeof ChatThreadKindSchema>;

export const ChatThreadPermissionProfileSchema = z.enum(["default", "review_git"]);
export type ChatThreadPermissionProfile = z.infer<typeof ChatThreadPermissionProfileSchema>;

export const ChatThreadSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  title: z.string().min(1),
  kind: ChatThreadKindSchema,
  permissionProfile: ChatThreadPermissionProfileSchema,
  titleEditedManually: z.boolean(),
  claudeSessionId: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number().int().nonnegative(),
  role: ChatRoleSchema,
  content: z.string(),
  attachments: z.array(z.lazy(() => ChatAttachmentSchema)).optional().default([]),
  createdAt: z.string().datetime(),
});

// ── Attachment Types ──

export const AttachmentSourceSchema = z.enum(["file_picker", "drag_drop", "clipboard_text", "clipboard_image"]);
export type AttachmentSource = z.infer<typeof AttachmentSourceSchema>;

export const ChatAttachmentSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  content: z.string(),
  storagePath: z.string().nullable(),
  source: AttachmentSourceSchema,
  createdAt: z.string().datetime(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const AttachmentInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  content: z.string(),
  source: AttachmentSourceSchema,
});
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export const ChatEventSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  idx: z.number().int().nonnegative(),
  type: ChatEventTypeSchema,
  payload: z.record(z.string(), z.any()),
  createdAt: z.string().datetime(),
});

export const AvailableCommandInputSchema = z.object({
  hint: z.string(),
});
export type AvailableCommandInput = z.infer<typeof AvailableCommandInputSchema>;

export const AvailableCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input: AvailableCommandInputSchema.nullable().optional(),
});
export type AvailableCommand = z.infer<typeof AvailableCommandSchema>;

export const AvailableCommandsUpdateSchema = z.object({
  availableCommands: z.array(AvailableCommandSchema),
});
export type AvailableCommandsUpdate = z.infer<typeof AvailableCommandsUpdateSchema>;

export const AssistantRenderHintSchema = z.enum(["markdown", "raw-file", "raw-fallback", "diff"]);
export type AssistantRenderHint = z.infer<typeof AssistantRenderHintSchema>;

export const ChatTimelineMessageItemSchema = z.object({
  kind: z.literal("message"),
  message: ChatMessageSchema,
  renderHint: AssistantRenderHintSchema.optional(),
  rawFileLanguage: z.string().optional(),
  isCompleted: z.boolean().optional(),
  context: z.array(ChatEventSchema).optional(),
});

export const ChatTimelinePlanFileOutputItemSchema = z.object({
  kind: z.literal("plan-file-output"),
  id: z.string(),
  messageId: z.string(),
  content: z.string(),
  filePath: z.string(),
  createdAt: z.string().datetime(),
});

export const ChatTimelineReadFileEntrySchema = z.object({
  label: z.string(),
  openPath: z.string().nullable(),
});

export const ChatTimelineExploreActivityEntrySchema = z.object({
  kind: z.enum(["read", "search"]),
  label: z.string(),
  openPath: z.string().nullable(),
  pending: z.boolean(),
  orderIdx: z.number().int(),
});

export const ChatTimelineActivityStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
});

export const ChatTimelineActivityItemSchema = z.object({
  kind: z.literal("activity"),
  messageId: z.string(),
  durationSeconds: z.number(),
  introText: z.string().nullable(),
  steps: z.array(ChatTimelineActivityStepSchema),
  defaultExpanded: z.boolean(),
});

export const ChatTimelineToolItemSchema = z.object({
  kind: z.literal("tool"),
  id: z.string(),
  event: ChatEventSchema.nullable(),
  sourceEvents: z.array(ChatEventSchema).optional(),
  toolUseId: z.string().optional(),
  toolName: z.string().nullable().optional(),
  shell: z.literal("bash").optional(),
  command: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
  durationSeconds: z.number().nullable().optional(),
  status: z.enum(["running", "success", "failed"]).optional(),
  rejectedByUser: z.boolean().optional(),
});

export const ChatTimelineEditedDiffItemSchema = z.object({
  kind: z.literal("edited-diff"),
  id: z.string(),
  eventId: z.string(),
  status: z.enum(["running", "success", "failed"]),
  diffKind: z.enum(["proposed", "actual", "none"]),
  changedFiles: z.array(z.string()),
  diff: z.string(),
  diffTruncated: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  rejectedByUser: z.boolean().optional(),
  createdAt: z.string().datetime(),
});

export const ChatTimelineExploreActivityItemSchema = z.object({
  kind: z.literal("explore-activity"),
  id: z.string(),
  status: z.enum(["running", "success"]),
  fileCount: z.number().int(),
  searchCount: z.number().int(),
  entries: z.array(ChatTimelineExploreActivityEntrySchema),
});

export const ChatTimelineSubagentStepSchema = z.object({
  toolUseId: z.string(),
  toolName: z.string(),
  label: z.string(),
  openPath: z.string().nullable(),
  status: z.enum(["running", "success"]),
});

export const ChatTimelineSubagentActivityItemSchema = z.object({
  kind: z.literal("subagent-activity"),
  id: z.string(),
  agentId: z.string(),
  agentType: z.string(),
  toolUseId: z.string(),
  status: z.enum(["running", "success", "failed"]),
  description: z.string(),
  lastMessage: z.string().nullable(),
  steps: z.array(ChatTimelineSubagentStepSchema),
  durationSeconds: z.number().nullable(),
});

export const ChatTimelineThinkingItemSchema = z.object({
  kind: z.literal("thinking"),
  id: z.string(),
  messageId: z.string(),
  content: z.string(),
  isStreaming: z.boolean(),
});

export const ChatTimelineErrorItemSchema = z.object({
  kind: z.literal("error"),
  id: z.string(),
  message: z.string(),
  createdAt: z.string().datetime(),
});

export const ChatTimelineItemSchema = z.discriminatedUnion("kind", [
  ChatTimelineMessageItemSchema,
  ChatTimelinePlanFileOutputItemSchema,
  ChatTimelineActivityItemSchema,
  ChatTimelineToolItemSchema,
  ChatTimelineEditedDiffItemSchema,
  ChatTimelineExploreActivityItemSchema,
  ChatTimelineSubagentActivityItemSchema,
  ChatTimelineThinkingItemSchema,
  ChatTimelineErrorItemSchema,
]);

export const ChatTimelineItemKindSchema = z.enum([
  "message",
  "plan-file-output",
  "activity",
  "tool",
  "edited-diff",
  "explore-activity",
  "subagent-activity",
  "thinking",
  "error",
]);

export const ChatTimelineSummarySchema = z.object({
  oldestRenderableKey: z.string().nullable(),
  oldestRenderableKind: ChatTimelineItemKindSchema.nullable(),
  oldestRenderableMessageId: z.string().nullable(),
  oldestRenderableHydrationPending: z.boolean(),
  headIdentityStable: z.boolean(),
});

export const ChatTimelineSnapshotSchema = z.object({
  timelineItems: z.array(ChatTimelineItemSchema),
  summary: ChatTimelineSummarySchema,
  newestSeq: z.number().int().nonnegative().nullable(),
  newestIdx: z.number().int().nonnegative().nullable(),
  messages: z.array(ChatMessageSchema),
  events: z.array(ChatEventSchema),
});

export const ChatThreadSnapshotSchema = z.object({
  messages: z.array(ChatMessageSchema),
  events: z.array(ChatEventSchema),
  timeline: ChatTimelineSnapshotSchema,
});

export const CreateRepositoryInputSchema = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});

export const CreateWorktreeInputSchema = z.object({
  branch: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
});

const MAX_THREAD_TITLE_LENGTH = 48;

export const CreateChatThreadInputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_THREAD_TITLE_LENGTH).optional(),
  kind: ChatThreadKindSchema.optional(),
  permissionProfile: ChatThreadPermissionProfileSchema.optional(),
});

export const RenameChatThreadTitleInputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_THREAD_TITLE_LENGTH),
});
export type RenameChatThreadTitleInput = z.infer<typeof RenameChatThreadTitleInputSchema>;

export const ChatModeSchema = z.enum(["default", "plan"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

export const SendChatMessageInputSchema = z.object({
  content: z.string().trim(),
  mode: ChatModeSchema.optional().default("default"),
  attachments: z.array(AttachmentInputSchema).max(20).optional().default([]),
}).refine(
  (data) => data.content.length > 0 || data.attachments.length > 0,
  { message: "Message must have content or attachments" },
);

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

export const DismissQuestionInputSchema = z.object({
  requestId: z.string().trim().min(1),
  reason: z.string().trim().optional(),
});
export type DismissQuestionInput = z.infer<typeof DismissQuestionInputSchema>;

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

export const UpdateRepositoryScriptsInputSchema = z.object({
  setupScript: z.array(z.string()).nullable().optional(),
  teardownScript: z.array(z.string()).nullable().optional(),
  runScript: z.array(z.string()).nullable().optional(),
  defaultBranch: z.string().trim().min(1).optional(),
});
export type UpdateRepositoryScriptsInput = z.infer<typeof UpdateRepositoryScriptsInputSchema>;

export type Repository = z.infer<typeof RepositorySchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type ChatTimelineItemKind = z.infer<typeof ChatTimelineItemKindSchema>;
export type ChatTimelineMessageItem = z.infer<typeof ChatTimelineMessageItemSchema>;
export type ChatTimelinePlanFileOutputItem = z.infer<typeof ChatTimelinePlanFileOutputItemSchema>;
export type ChatTimelineReadFileEntry = z.infer<typeof ChatTimelineReadFileEntrySchema>;
export type ChatTimelineActivityStep = z.infer<typeof ChatTimelineActivityStepSchema>;
export type ChatTimelineActivityItem = z.infer<typeof ChatTimelineActivityItemSchema>;
export type ChatTimelineToolItem = z.infer<typeof ChatTimelineToolItemSchema>;
export type ChatTimelineEditedDiffItem = z.infer<typeof ChatTimelineEditedDiffItemSchema>;
export type ChatTimelineExploreActivityEntry = z.infer<typeof ChatTimelineExploreActivityEntrySchema>;
export type ChatTimelineExploreActivityItem = z.infer<typeof ChatTimelineExploreActivityItemSchema>;
export type ChatTimelineSubagentStep = z.infer<typeof ChatTimelineSubagentStepSchema>;
export type ChatTimelineSubagentActivityItem = z.infer<typeof ChatTimelineSubagentActivityItemSchema>;
export type ChatTimelineThinkingItem = z.infer<typeof ChatTimelineThinkingItemSchema>;
export type ChatTimelineErrorItem = z.infer<typeof ChatTimelineErrorItemSchema>;
export type ChatTimelineItem = z.infer<typeof ChatTimelineItemSchema>;
export type ChatTimelineSummary = z.infer<typeof ChatTimelineSummarySchema>;
export type ChatTimelineSnapshot = z.infer<typeof ChatTimelineSnapshotSchema>;
export type ChatThreadSnapshot = z.infer<typeof ChatThreadSnapshotSchema>;
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

export const GitBranchDiffSummarySchema = z.object({
  branch: z.string(),
  baseBranch: z.string(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
});
export type GitBranchDiffSummary = z.infer<typeof GitBranchDiffSummarySchema>;

export const GitCommitInputSchema = z.object({
  message: z.string().trim().optional().default(""),
});
export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;

export const GitDiffSchema = z.object({
  diff: z.string(),
  summary: z.string(),
});
export type GitDiff = z.infer<typeof GitDiffSchema>;

export const ReviewProviderSchema = z.enum(["github", "gitlab", "unknown"]);
export type ReviewProvider = z.infer<typeof ReviewProviderSchema>;

export const ReviewKindSchema = z.enum(["pr", "mr"]);
export type ReviewKind = z.infer<typeof ReviewKindSchema>;

export const ReviewStateSchema = z.enum(["open", "merged", "closed"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ReviewRefSchema = z.object({
  number: z.number().int().positive(),
  display: z.string().min(1),
  url: z.string().url(),
  state: ReviewStateSchema,
});
export type ReviewRef = z.infer<typeof ReviewRefSchema>;

export const RepositoryReviewStateSchema = z.object({
  provider: ReviewProviderSchema,
  kind: ReviewKindSchema.nullable(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  reviewsByBranch: z.record(z.string(), ReviewRefSchema),
});
export type RepositoryReviewState = z.infer<typeof RepositoryReviewStateSchema>;

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

// ── Script Execution Types ──

export const ScriptResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
});
export type ScriptResult = z.infer<typeof ScriptResultSchema>;

// ── External App Types ──

export const ExternalAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  bundleId: z.string(),
  path: z.string(),
});
export type ExternalApp = z.infer<typeof ExternalAppSchema>;

export const OpenInAppInputSchema = z.object({
  appId: z.string().trim().min(1),
  targetPath: z.string().trim().min(1),
});
export type OpenInAppInput = z.infer<typeof OpenInAppInputSchema>;

// ── Model Provider Types ──

export const ModelProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelId: z.string(),
  baseUrl: z.string(),
  apiKeyMasked: z.string(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const CreateModelProviderInputSchema = z.object({
  name: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
});
export type CreateModelProviderInput = z.infer<typeof CreateModelProviderInputSchema>;

export const UpdateModelProviderInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
});
export type UpdateModelProviderInput = z.infer<typeof UpdateModelProviderInputSchema>;

export const TestModelProviderInputSchema = z.object({
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
});
export type TestModelProviderInput = z.infer<typeof TestModelProviderInputSchema>;
