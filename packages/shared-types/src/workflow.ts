import { z } from "zod";

export const WorktreeStatusSchema = z.enum(["active", "archived", "creating", "create_failed", "deleting", "delete_failed"]);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatEventTypeSchema = z.enum([
  "message.delta",
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
  lastCreateError: z.string().nullable().optional(),
  lastDeleteError: z.string().nullable().optional(),
  branchRenamed: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const SaveAutomationTargetSchema = z.enum(["active_run_session", "workspace_terminal"]);
export type SaveAutomationTarget = z.infer<typeof SaveAutomationTargetSchema>;

export const SaveAutomationActionTypeSchema = z.enum(["send_stdin"]);
export type SaveAutomationActionType = z.infer<typeof SaveAutomationActionTypeSchema>;

export const SaveAutomationConfigSchema = z.object({
  enabled: z.boolean(),
  target: SaveAutomationTargetSchema,
  filePatterns: z.array(z.string().trim().min(1)).default([]),
  actionType: SaveAutomationActionTypeSchema.default("send_stdin"),
  payload: z.string().trim(),
  debounceMs: z.number().int().min(0).max(5000).default(400),
});
export type SaveAutomationConfig = z.infer<typeof SaveAutomationConfigSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  setupScript: z.array(z.string()).nullable().optional(),
  teardownScript: z.array(z.string()).nullable().optional(),
  runScript: z.array(z.string()).nullable().optional(),
  saveAutomation: SaveAutomationConfigSchema.nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  worktrees: z.array(WorktreeSchema),
});

export const AutomationRunStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

export const AutomationTriggerKindSchema = z.enum(["manual", "schedule"]);
export type AutomationTriggerKind = z.infer<typeof AutomationTriggerKindSchema>;

export const AutomationRunSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  repositoryId: z.string(),
  worktreeId: z.string(),
  threadId: z.string().nullable(),
  status: AutomationRunStatusSchema,
  triggerKind: AutomationTriggerKindSchema,
  scheduledFor: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

export const AutomationPromptVersionSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  content: z.string(),
  source: z.string().min(1),
  restoredFromVersionId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutomationPromptVersion = z.infer<typeof AutomationPromptVersionSchema>;

export const ChatThreadKindSchema = z.enum(["default", "review"]);
export type ChatThreadKind = z.infer<typeof ChatThreadKindSchema>;

export const ChatThreadPermissionProfileSchema = z.enum(["default", "review_git"]);
export type ChatThreadPermissionProfile = z.infer<typeof ChatThreadPermissionProfileSchema>;

export const ChatThreadPermissionModeSchema = z.enum(["default", "full_access"]);
export type ChatThreadPermissionMode = z.infer<typeof ChatThreadPermissionModeSchema>;

export const ChatModeSchema = z.enum(["default", "plan"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

export const ChatQueuedMessageStatusSchema = z.enum(["queued", "dispatch_requested", "dispatching"]);
export type ChatQueuedMessageStatus = z.infer<typeof ChatQueuedMessageStatusSchema>;

export const CliAgentSchema = z.enum(["claude", "codex", "cursor", "opencode"]);
export type CliAgent = z.infer<typeof CliAgentSchema>;

export const BUILTIN_CHAT_MODELS_BY_AGENT = {
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  codex: [],
  cursor: [
    "default[]",
    "composer-2[fast=true]",
    "composer-1.5[]",
    "gpt-5.4[context=272k,reasoning=medium,fast=false]",
    "gpt-5.4-mini[reasoning=medium]",
    "gpt-5.3-codex[reasoning=medium,fast=false]",
    "gpt-5.3-codex-spark[reasoning=medium]",
    "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]",
    "claude-opus-4-7[thinking=true,context=200k,effort=high]",
  ],
  opencode: ["opencode/minimax-m2.5-free", "opencode/ling-2.6-flash-free", "opencode/nemotron-3-super-free"],
} as const satisfies Record<CliAgent, readonly string[]>;

export const DEFAULT_CHAT_MODEL_BY_AGENT = {
  claude: "claude-sonnet-4-6",
  codex: "",
  cursor: "default[]",
  opencode: "opencode/minimax-m2.5-free",
} as const satisfies Record<CliAgent, string>;

export const AutomationSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  targetWorktreeId: z.string(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  agent: CliAgentSchema,
  model: z.string().min(1),
  modelProviderId: z.string().nullable(),
  permissionMode: ChatThreadPermissionModeSchema,
  chatMode: ChatModeSchema,
  enabled: z.boolean(),
  rrule: z.string().min(1),
  timezone: z.string().min(1),
  dtstart: z.string().datetime(),
  nextRunAt: z.string().datetime(),
  lastRunAt: z.string().datetime().nullable(),
  latestRun: AutomationRunSchema.nullable().optional(),
  promptVersionCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const ChatThreadSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  title: z.string().min(1),
  kind: ChatThreadKindSchema,
  permissionProfile: ChatThreadPermissionProfileSchema,
  permissionMode: ChatThreadPermissionModeSchema,
  mode: ChatModeSchema,
  titleEditedManually: z.boolean(),
  agent: CliAgentSchema.optional(),
  model: z.string().min(1).optional(),
  modelProviderId: z.string().nullable().optional(),
  handoffSourceThreadId: z.string().nullable().optional(),
  handoffSourcePlanEventId: z.string().nullable().optional(),
  claudeSessionId: z.string().nullable(),
  codexSessionId: z.string().nullable().optional(),
  cursorSessionId: z.string().nullable().optional(),
  opencodeSessionId: z.string().nullable().optional(),
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

export const ChatQueuedAttachmentSchema = z.object({
  id: z.string(),
  queuedMessageId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  content: z.string(),
  storagePath: z.string().nullable(),
  source: AttachmentSourceSchema,
  createdAt: z.string().datetime(),
});
export type ChatQueuedAttachment = z.infer<typeof ChatQueuedAttachmentSchema>;

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

export const ChatQueuedMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number().int().nonnegative(),
  content: z.string(),
  mode: ChatModeSchema,
  status: ChatQueuedMessageStatusSchema,
  dispatchRequestedAt: z.string().datetime().nullable(),
  attachments: z.array(ChatQueuedAttachmentSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChatQueuedMessage = z.infer<typeof ChatQueuedMessageSchema>;

export const WorkspaceSyncEventTypeSchema = z.enum([
  "repository.created",
  "repository.updated",
  "repository.deleted",
  "worktree.created",
  "worktree.updated",
  "worktree.deletion_started",
  "worktree.deletion_failed",
  "worktree.deleted",
  "thread.created",
  "thread.updated",
  "thread.deleted",
]);
export type WorkspaceSyncEventType = z.infer<typeof WorkspaceSyncEventTypeSchema>;

export const WorkspaceSyncEventSchema = z.object({
  id: z.string(),
  type: WorkspaceSyncEventTypeSchema,
  repositoryId: z.string().nullable().optional(),
  worktreeId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
});

export const DevicePlatformSchema = z.enum(["android", "ios-simulator"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceConnectionKindSchema = z.enum(["usb", "wifi", "emulator", "simulator", "remote"]);
export type DeviceConnectionKind = z.infer<typeof DeviceConnectionKindSchema>;

export const DeviceStatusSchema = z.enum(["offline", "available", "connecting", "streaming", "error"]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const DeviceIssueSeveritySchema = z.enum(["info", "warning", "error"]);
export type DeviceIssueSeverity = z.infer<typeof DeviceIssueSeveritySchema>;

export const DeviceSummarySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  platform: DevicePlatformSchema,
  status: DeviceStatusSchema,
  connectionKind: DeviceConnectionKindSchema,
  supportsEmbeddedStream: z.boolean(),
  supportsControl: z.boolean(),
  serial: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

export const DeviceStreamControlTransportSchema = z.enum(["iframe", "websocket", "none"]);
export type DeviceStreamControlTransport = z.infer<typeof DeviceStreamControlTransportSchema>;

export const DeviceStreamSessionSchema = z.object({
  sessionId: z.string(),
  deviceId: z.string(),
  platform: DevicePlatformSchema,
  viewerUrl: z.string().min(1),
  controlTransport: DeviceStreamControlTransportSchema,
  startedAt: z.string().datetime(),
});
export type DeviceStreamSession = z.infer<typeof DeviceStreamSessionSchema>;

export const DeviceIssueSchema = z.object({
  id: z.string(),
  platform: DevicePlatformSchema.nullable().optional(),
  severity: DeviceIssueSeveritySchema,
  message: z.string().min(1),
});
export type DeviceIssue = z.infer<typeof DeviceIssueSchema>;

export const DeviceInventorySnapshotSchema = z.object({
  devices: z.array(DeviceSummarySchema),
  activeSessions: z.array(DeviceStreamSessionSchema),
  issues: z.array(DeviceIssueSchema).default([]),
  refreshedAt: z.string().datetime(),
});
export type DeviceInventorySnapshot = z.infer<typeof DeviceInventorySnapshotSchema>;

export const StartDeviceStreamInputSchema = z.object({
  preferredPlayer: z.string().trim().min(1).optional(),
});
export type StartDeviceStreamInput = z.infer<typeof StartDeviceStreamInputSchema>;

export const StopDeviceStreamInputSchema = z.object({
  sessionId: z.string().trim().min(1),
});
export type StopDeviceStreamInput = z.infer<typeof StopDeviceStreamInputSchema>;

export const SendDeviceControlInputSchema = z.object({
  action: z.string().trim().min(1),
  payload: z.record(z.string(), z.any()).optional(),
});
export type SendDeviceControlInput = z.infer<typeof SendDeviceControlInputSchema>;

export const ClipboardTextSchema = z.object({
  text: z.string(),
});
export type ClipboardText = z.infer<typeof ClipboardTextSchema>;

export const UpdateAndroidClipboardInputSchema = z.object({
  text: z.string(),
  paste: z.boolean().optional(),
});
export type UpdateAndroidClipboardInput = z.infer<typeof UpdateAndroidClipboardInputSchema>;


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
  changeSource: z.enum(["edit-tool", "worktree-diff"]).optional(),
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
  status: z.enum(["running", "success", "failed"]),
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
  collectionsIncluded: z.boolean().optional(),
  messages: z.array(ChatMessageSchema),
  events: z.array(ChatEventSchema),
});

export const ChatThreadSnapshotSchema = z.object({
  messages: z.array(ChatMessageSchema),
  events: z.array(ChatEventSchema),
  timeline: ChatTimelineSnapshotSchema,
});

export const ChatThreadStatusSchema = z.enum([
  "waiting_approval",
  "review_plan",
  "running",
  "idle",
]);

export const ChatThreadStatusSnapshotSchema = z.object({
  status: ChatThreadStatusSchema,
  newestIdx: z.number().int().nonnegative().nullable(),
});

export const CreateRepositoryInputSchema = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});

export const CreateWorktreeInputSchema = z.object({
  branch: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
});

export const CreateWorktreeResultSchema = z.object({
  worktree: WorktreeSchema,
  pending: z.boolean(),
});

const MAX_THREAD_TITLE_LENGTH = 48;

export const CreateChatThreadInputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_THREAD_TITLE_LENGTH).optional(),
  kind: ChatThreadKindSchema.optional(),
  permissionProfile: ChatThreadPermissionProfileSchema.optional(),
  permissionMode: ChatThreadPermissionModeSchema.optional(),
  agent: CliAgentSchema.optional(),
  model: z.string().trim().min(1).optional(),
  modelProviderId: z.string().trim().min(1).nullable().optional(),
});

export const CreateAutomationInputSchema = z.object({
  repositoryId: z.string().trim().min(1),
  targetWorktreeId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  agent: CliAgentSchema,
  model: z.string().trim().min(1),
  modelProviderId: z.string().trim().min(1).nullable().optional(),
  permissionMode: ChatThreadPermissionModeSchema,
  chatMode: ChatModeSchema,
  rrule: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
});
export type CreateAutomationInput = z.infer<typeof CreateAutomationInputSchema>;

export const RenameChatThreadTitleInputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_THREAD_TITLE_LENGTH),
});
export type RenameChatThreadTitleInput = z.infer<typeof RenameChatThreadTitleInputSchema>;

export const UpdateChatThreadModeInputSchema = z.object({
  mode: ChatModeSchema,
});
export type UpdateChatThreadModeInput = z.infer<typeof UpdateChatThreadModeInputSchema>;

export const UpdateAutomationInputSchema = CreateAutomationInputSchema.omit({
  repositoryId: true,
}).partial().extend({
  enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one automation field must be updated",
});
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationInputSchema>;

export const UpdateChatThreadPermissionModeInputSchema = z.object({
  permissionMode: ChatThreadPermissionModeSchema,
});
export type UpdateChatThreadPermissionModeInput = z.infer<typeof UpdateChatThreadPermissionModeInputSchema>;

export const UpdateChatThreadAgentSelectionInputSchema = z.object({
  agent: CliAgentSchema,
  model: z.string().trim().min(1),
  modelProviderId: z.string().trim().min(1).nullable().optional(),
});
export type UpdateChatThreadAgentSelectionInput = z.infer<typeof UpdateChatThreadAgentSelectionInputSchema>;

export type ThreadSelectionLike = {
  agent: CliAgent;
  model: string;
  modelProviderId?: string | null;
};

function normalizeThreadSelectionProviderId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function hasSameThreadSelection(
  current: ThreadSelectionLike | null | undefined,
  next: ThreadSelectionLike | null | undefined,
): boolean {
  if (!current || !next) {
    return false;
  }

  return current.agent === next.agent
    && current.model === next.model
    && normalizeThreadSelectionProviderId(current.modelProviderId) === normalizeThreadSelectionProviderId(next.modelProviderId);
}

export function shouldPreserveThreadSelectionSessionIds(params: {
  threadKind: ChatThreadKind;
  currentAgent: CliAgent | null | undefined;
  currentModelProviderId?: string | null;
  nextAgent: CliAgent;
  nextModelProviderId?: string | null;
}): boolean {
  return params.threadKind === "default"
    && params.currentAgent === params.nextAgent
    && normalizeThreadSelectionProviderId(params.currentModelProviderId)
      === normalizeThreadSelectionProviderId(params.nextModelProviderId);
}

export const SendChatMessageInputSchema = z.object({
  content: z.string().trim(),
  mode: ChatModeSchema.optional().default("default"),
  attachments: z.array(AttachmentInputSchema).max(20).optional().default([]),
  expectedWorktreeId: z.string().trim().min(1).optional(),
}).refine(
  (data) => data.content.length > 0 || data.attachments.length > 0,
  { message: "Message must have content or attachments" },
);
export type SendChatMessageInput = z.infer<typeof SendChatMessageInputSchema>;

export const QueueChatMessageInputSchema = z.object({
  content: z.string().trim(),
  mode: ChatModeSchema.optional().default("default"),
  attachments: z.array(AttachmentInputSchema).max(20).optional().default([]),
  expectedWorktreeId: z.string().trim().min(1).optional(),
}).refine(
  (data) => data.content.length > 0 || data.attachments.length > 0,
  { message: "Queued message must have content or attachments" },
);
export type QueueChatMessageInput = z.infer<typeof QueueChatMessageInputSchema>;

export const UpdateQueuedMessageInputSchema = z.object({
  content: z.string().trim(),
});
export type UpdateQueuedMessageInput = z.infer<typeof UpdateQueuedMessageInputSchema>;

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

export const DismissPlanInputSchema = z.object({
  reason: z.string().trim().optional(),
});
export type DismissPlanInput = z.infer<typeof DismissPlanInputSchema>;

export const PlanRevisionInputSchema = z.object({
  feedback: z.string().trim().min(1),
});
export type PlanRevisionInput = z.infer<typeof PlanRevisionInputSchema>;

export const ApprovePlanExecutionKindSchema = z.enum(["same_thread_switch", "handoff"]);
export type ApprovePlanExecutionKind = z.infer<typeof ApprovePlanExecutionKindSchema>;

export const ApprovePlanInputSchema = z.object({
  agent: CliAgentSchema,
  model: z.string().trim().min(1),
  modelProviderId: z.string().trim().min(1).nullable().optional(),
  executionKind: ApprovePlanExecutionKindSchema.optional(),
});
export type ApprovePlanInput = z.infer<typeof ApprovePlanInputSchema>;

export function shouldHandoffApprovedPlanExecution(params: {
  messageCount: number;
  threadKind: ChatThreadKind;
  sourceAgent: CliAgent;
  sourceModelProviderId: string | null | undefined;
  sourceProviderHasBaseUrl: boolean;
  targetAgent: CliAgent;
  targetModelProviderId: string | null | undefined;
}): boolean {
  if (params.messageCount === 0) {
    return false;
  }

  if (params.threadKind !== "default") {
    return true;
  }

  if (params.sourceAgent !== params.targetAgent) {
    return true;
  }

  if (params.sourceAgent === "claude" && params.sourceProviderHasBaseUrl) {
    return true;
  }

  return (params.sourceModelProviderId ?? null) !== (params.targetModelProviderId ?? null);
}

export function resolveApprovedPlanExecutionKind(params: {
  requestedExecutionKind?: ApprovePlanExecutionKind | null | undefined;
  messageCount: number;
  threadKind: ChatThreadKind;
  sourceAgent: CliAgent;
  sourceModelProviderId: string | null | undefined;
  sourceProviderHasBaseUrl: boolean;
  targetAgent: CliAgent;
  targetModelProviderId: string | null | undefined;
}): ApprovePlanExecutionKind {
  if (params.requestedExecutionKind === "handoff") {
    return "handoff";
  }

  return shouldHandoffApprovedPlanExecution(params)
    ? "handoff"
    : "same_thread_switch";
}

export const ApprovePlanResultSchema = z.object({
  executionKind: ApprovePlanExecutionKindSchema,
  sourceThreadId: z.string().trim().min(1),
  executionThreadId: z.string().trim().min(1),
});
export type ApprovePlanResult = z.infer<typeof ApprovePlanResultSchema>;

export const OpenWorktreeFileInputSchema = z.object({
  path: z.string().trim().min(1),
});
export type OpenWorktreeFileInput = z.infer<typeof OpenWorktreeFileInputSchema>;

export const GetWorktreeFileContentQuerySchema = z.object({
  path: z.string().trim().min(1),
});
export type GetWorktreeFileContentQuery = z.infer<typeof GetWorktreeFileContentQuerySchema>;

export const WorktreeFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  mimeType: z.string(),
});
export type WorktreeFileContent = z.infer<typeof WorktreeFileContentSchema>;

export const UpdateWorktreeFileContentInputSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
});
export type UpdateWorktreeFileContentInput = z.infer<typeof UpdateWorktreeFileContentInputSchema>;

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

export const UpdateWorktreeBaseBranchInputSchema = z.object({
  baseBranch: z.string().trim().min(1),
});
export type UpdateWorktreeBaseBranchInput = z.infer<typeof UpdateWorktreeBaseBranchInputSchema>;

export const UpdateRepositoryScriptsInputSchema = z.object({
  setupScript: z.array(z.string()).nullable().optional(),
  teardownScript: z.array(z.string()).nullable().optional(),
  runScript: z.array(z.string()).nullable().optional(),
  saveAutomation: SaveAutomationConfigSchema.nullable().optional(),
  defaultBranch: z.string().trim().min(1).optional(),
});
export type UpdateRepositoryScriptsInput = z.infer<typeof UpdateRepositoryScriptsInputSchema>;

export type Repository = z.infer<typeof RepositorySchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type WorkspaceSyncEvent = z.infer<typeof WorkspaceSyncEventSchema>;
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
export type ChatTimelineErrorItem = z.infer<typeof ChatTimelineErrorItemSchema>;
export type ChatTimelineItem = z.infer<typeof ChatTimelineItemSchema>;
export type ChatTimelineSummary = z.infer<typeof ChatTimelineSummarySchema>;
export type ChatTimelineSnapshot = z.infer<typeof ChatTimelineSnapshotSchema>;
export type ChatThreadSnapshot = z.infer<typeof ChatThreadSnapshotSchema>;
export type ChatThreadStatus = z.infer<typeof ChatThreadStatusSchema>;
export type ChatThreadStatusSnapshot = z.infer<typeof ChatThreadStatusSnapshotSchema>;
export type CreateRepositoryInput = z.infer<typeof CreateRepositoryInputSchema>;
export type CreateWorktreeInput = z.infer<typeof CreateWorktreeInputSchema>;
export type CreateWorktreeResult = z.infer<typeof CreateWorktreeResultSchema>;
export type CreateChatThreadInput = z.infer<typeof CreateChatThreadInputSchema>;

export const FileEntrySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory"]),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const SlashCommandSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  argumentHint: z.string(),
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

export const SlashCommandCatalogSchema = z.object({
  commands: z.array(SlashCommandSchema),
  updatedAt: z.string().datetime(),
});
export type SlashCommandCatalog = z.infer<typeof SlashCommandCatalogSchema>;

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
  upstream: z.string().nullable().default(null),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
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
  agent: CliAgentSchema.optional(),
  model: z.string().trim().min(1).optional(),
  modelProviderId: z.string().trim().min(1).nullable().optional(),
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

export const FilesystemReadAttachmentsInputSchema = z.object({
  paths: z.array(z.string().trim().min(1)).min(1).max(32),
});
export type FilesystemReadAttachmentsInput = z.infer<typeof FilesystemReadAttachmentsInputSchema>;

export const FilesystemReadAttachmentSchema = z.object({
  path: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  content: z.string(),
});
export type FilesystemReadAttachment = z.infer<typeof FilesystemReadAttachmentSchema>;

export const FilesystemReadAttachmentsResponseSchema = z.object({
  attachments: z.array(FilesystemReadAttachmentSchema),
});
export type FilesystemReadAttachmentsResponse = z.infer<typeof FilesystemReadAttachmentsResponseSchema>;

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
  iconUrl: z.string().trim().min(1).optional(),
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
  agent: CliAgentSchema.optional(),
  name: z.string(),
  modelId: z.string(),
  baseUrl: z.string().nullable().optional(),
  apiKeyMasked: z.string(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const CreateModelProviderInputSchema = z.object({
  agent: CliAgentSchema.optional().default("claude"),
  name: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().trim().optional(),
});
export type CreateModelProviderInput = z.input<typeof CreateModelProviderInputSchema>;

export const UpdateModelProviderInputSchema = z.object({
  agent: CliAgentSchema.optional(),
  name: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().nullable().optional(),
  apiKey: z.string().trim().nullable().optional(),
});
export type UpdateModelProviderInput = z.input<typeof UpdateModelProviderInputSchema>;

export const TestModelProviderInputSchema = z.object({
  agent: CliAgentSchema.optional().default("claude"),
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
});
export type TestModelProviderInput = z.input<typeof TestModelProviderInputSchema>;

export const CodexModelCatalogEntrySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
});
export type CodexModelCatalogEntry = z.infer<typeof CodexModelCatalogEntrySchema>;

export const CodexModelCatalogSchema = z.object({
  models: z.array(CodexModelCatalogEntrySchema),
  fetchedAt: z.string().datetime(),
});
export type CodexModelCatalog = z.infer<typeof CodexModelCatalogSchema>;

export const OpencodeModelCatalogEntrySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
});
export type OpencodeModelCatalogEntry = z.infer<typeof OpencodeModelCatalogEntrySchema>;

export const OpencodeModelCatalogSchema = z.object({
  models: z.array(OpencodeModelCatalogEntrySchema),
  fetchedAt: z.string().datetime(),
});
export type OpencodeModelCatalog = z.infer<typeof OpencodeModelCatalogSchema>;

export const CursorModelCatalogEntrySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
});
export type CursorModelCatalogEntry = z.infer<typeof CursorModelCatalogEntrySchema>;

export const CursorModelCatalogSchema = z.object({
  models: z.array(CursorModelCatalogEntrySchema),
  fetchedAt: z.string().datetime(),
});
export type CursorModelCatalog = z.infer<typeof CursorModelCatalogSchema>;
