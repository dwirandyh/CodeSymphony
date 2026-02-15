import type {
  ApprovalCheckpoint,
  Run,
  RunEventType,
  RunStep,
  RunStepStatus,
  RunStatus,
  Workflow,
  WorkflowStep,
} from "@codesymphony/shared-types";
import type {
  ApprovalDecision as DbApprovalDecision,
  ApprovalDecisionType,
  Run as DbRun,
  RunEventType as DbRunEventType,
  RunStep as DbRunStep,
  RunStatus as DbRunStatus,
  RunStepStatus as DbRunStepStatus,
  Workflow as DbWorkflow,
  WorkflowStep as DbWorkflowStep,
} from "@prisma/client";

export function mapWorkflow(workflow: DbWorkflow & { steps: DbWorkflowStep[] }): Workflow {
  return {
    id: workflow.id,
    name: workflow.name,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
    steps: workflow.steps
      .sort((a, b) => a.order - b.order)
      .map((step): WorkflowStep => ({
        id: step.id,
        order: step.order,
        title: step.title,
        kind: step.kind,
        prompt: step.prompt,
      })),
  };
}

export function mapRunStatus(status: DbRunStatus): RunStatus {
  return status;
}

export function mapRunStepStatus(status: DbRunStepStatus): RunStepStatus {
  return status;
}

export function mapRunStep(step: DbRunStep): RunStep {
  return {
    id: step.id,
    runId: step.runId,
    workflowStepId: step.workflowStepId,
    order: step.order,
    title: step.title,
    kind: step.kind,
    prompt: step.prompt,
    status: mapRunStepStatus(step.status),
    output: step.output,
    error: step.error,
    startedAt: step.startedAt?.toISOString() ?? null,
    finishedAt: step.finishedAt?.toISOString() ?? null,
  };
}

export function mapRun(
  run: DbRun & {
    steps: DbRunStep[];
  },
): Run {
  return {
    id: run.id,
    workflowId: run.workflowId,
    status: mapRunStatus(run.status),
    currentStepIndex: run.currentStepIndex,
    sessionId: run.sessionId,
    error: run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    steps: run.steps.sort((a, b) => a.order - b.order).map(mapRunStep),
  };
}

export function mapApprovalDecision(decision: ApprovalDecisionType): "approved" | "rejected" {
  return decision;
}

export function mapApprovalCheckpoint(approval: DbApprovalDecision): ApprovalCheckpoint {
  return {
    runId: approval.runId,
    runStepId: approval.runStepId,
    decision: mapApprovalDecision(approval.decision),
    comment: approval.comment,
    createdAt: approval.createdAt.toISOString(),
  };
}

export function mapEventTypeToDb(type: RunEventType): DbRunEventType {
  const mapping: Record<RunEventType, DbRunEventType> = {
    "run.status_changed": "run_status_changed",
    "run.completed": "run_completed",
    "run.failed": "run_failed",
    "step.started": "step_started",
    "step.log": "step_log",
    "step.completed": "step_completed",
    "approval.requested": "approval_requested",
    "approval.decided": "approval_decided",
  };

  return mapping[type];
}
