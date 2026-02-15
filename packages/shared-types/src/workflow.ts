import { z } from "zod";

export const WorktreeStatusSchema = z.enum(["active", "archived"]);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const ChatRoleSchema = z.enum(["user", "assistant", "system"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatEventTypeSchema = z.enum([
  "message.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
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
  branch: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).optional(),
});

export const CreateChatThreadInputSchema = z.object({
  title: z.string().trim().min(1).optional(),
});

export const SendChatMessageInputSchema = z.object({
  content: z.string().trim().min(1),
});

export type Repository = z.infer<typeof RepositorySchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type CreateRepositoryInput = z.infer<typeof CreateRepositoryInputSchema>;
export type CreateWorktreeInput = z.infer<typeof CreateWorktreeInputSchema>;
export type CreateChatThreadInput = z.infer<typeof CreateChatThreadInputSchema>;
export type SendChatMessageInput = z.infer<typeof SendChatMessageInputSchema>;
