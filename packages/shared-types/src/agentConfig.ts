import { z } from "zod";
import { CliAgentSchema } from "./workflow.js";

export const AgentConfigSchema = z.object({
  claudePath: z.string().nullable(),
  codexPath: z.string().nullable(),
  opencodePath: z.string().nullable(),
  claudePathResolved: z.string(),
  codexPathResolved: z.string(),
  opencodePathResolved: z.string(),
  cursorApiKeyMasked: z.string(),
  cursorApiKeySet: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const UpdateAgentConfigInputSchema = z.object({
  claudePath: z.string().optional(),
  codexPath: z.string().optional(),
  opencodePath: z.string().optional(),
  cursorApiKey: z.string().optional(),
});
export type UpdateAgentConfigInput = z.infer<typeof UpdateAgentConfigInputSchema>;

export const TestAgentConfigInputSchema = z.object({
  agent: CliAgentSchema,
  value: z.string(),
});
export type TestAgentConfigInput = z.infer<typeof TestAgentConfigInputSchema>;

export const TestAgentConfigResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
  error: z.string().optional(),
});
export type TestAgentConfigResult = z.infer<typeof TestAgentConfigResultSchema>;
