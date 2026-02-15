import { z } from "zod";

export const StepKindSchema = z.enum(["prompt", "approval"]);
export type StepKind = z.infer<typeof StepKindSchema>;

const WorkflowStepBaseSchema = z.object({
  id: z.string().optional(),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  kind: StepKindSchema,
  prompt: z.string().trim().min(1).optional().nullable(),
});

const refineWorkflowStep = <T extends { kind: StepKind; prompt?: string | null }>(schema: z.ZodType<T>) =>
  schema.superRefine((step, ctx) => {
    if (step.kind === "prompt" && !step.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "Prompt step requires prompt text",
      });
    }
  });

export const WorkflowStepSchema = refineWorkflowStep(WorkflowStepBaseSchema);
const WorkflowStepInputSchema = refineWorkflowStep(WorkflowStepBaseSchema.omit({ id: true }));

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  steps: z.array(WorkflowStepSchema),
});

export const CreateWorkflowInputSchema = z.object({
  name: z.string().trim().min(1),
  steps: z.array(WorkflowStepInputSchema).min(1),
});

export const UpdateWorkflowInputSchema = z.object({
  name: z.string().trim().min(1),
  steps: z.array(WorkflowStepInputSchema).min(1),
});

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_approval",
  "approved",
  "rejected",
  "succeeded",
  "failed",
]);
export type RunStepStatus = z.infer<typeof RunStepStatusSchema>;

export const RunStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workflowStepId: z.string(),
  order: z.number().int().nonnegative(),
  title: z.string(),
  kind: StepKindSchema,
  prompt: z.string().nullable(),
  status: RunStepStatusSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

export const RunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: RunStatusSchema,
  currentStepIndex: z.number().int().nonnegative(),
  sessionId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  steps: z.array(RunStepSchema),
});

export const CreateRunInputSchema = z.object({
  workflowId: z.string().min(1),
});

export const ApprovalDecisionSchema = z.enum(["approved", "rejected"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalCheckpointSchema = z.object({
  runId: z.string(),
  runStepId: z.string(),
  decision: ApprovalDecisionSchema,
  comment: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const ApproveRunInputSchema = z.object({
  decision: ApprovalDecisionSchema,
  comment: z.string().trim().min(1).optional(),
});

export const RunEventTypeSchema = z.enum([
  "run.status_changed",
  "run.completed",
  "run.failed",
  "step.started",
  "step.log",
  "step.completed",
  "approval.requested",
  "approval.decided",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  idx: z.number().int().nonnegative(),
  type: RunEventTypeSchema,
  payload: z.record(z.string(), z.any()),
  createdAt: z.string().datetime(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;
export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowInputSchema>;
export type Run = z.infer<typeof RunSchema>;
export type RunStep = z.infer<typeof RunStepSchema>;
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
export type ApprovalCheckpoint = z.infer<typeof ApprovalCheckpointSchema>;
export type ApproveRunInput = z.infer<typeof ApproveRunInputSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
