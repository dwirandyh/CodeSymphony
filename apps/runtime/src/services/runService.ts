import type { ApprovalDecisionType, PrismaClient, RunStatus, RunStepStatus, StepKind } from "@prisma/client";
import { transition, type RunMachineState, type RunMachineEvent } from "@codesymphony/orchestrator-core";
import { ApproveRunInputSchema, CreateRunInputSchema, type ApprovalCheckpoint, type Run } from "@codesymphony/shared-types";
import { mapApprovalCheckpoint, mapRun } from "./mappers";
import type { RuntimeDeps } from "../types";

const AUTO_EXECUTE_DELAY_MS = 10;

type ExecutionState = {
  running: boolean;
};

function mapDbStatus(status: RunMachineState["status"]): RunStatus {
  return status;
}

function statusForActiveStep(kind: StepKind): RunStepStatus {
  if (kind === "approval") {
    return "waiting_approval";
  }

  return "running";
}

function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

async function loadRun(prisma: PrismaClient, runId: string) {
  return prisma.run.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
}

function buildMachineState(run: { status: RunStatus; currentStepIndex: number; steps: unknown[] }): RunMachineState {
  return {
    status: run.status,
    currentStepIndex: run.currentStepIndex,
    totalSteps: run.steps.length,
  };
}

export function createRunService(deps: RuntimeDeps) {
  const executions = new Map<string, ExecutionState>();

  async function emitStatus(runId: string, status: RunStatus) {
    await deps.eventHub.emit(runId, "run.status_changed", { status });
  }

  async function loadMappedRun(runId: string): Promise<Run | null> {
    const run = await loadRun(deps.prisma, runId);

    if (!run) {
      return null;
    }

    return mapRun(run);
  }

  async function applyTransition(runId: string, event: RunMachineEvent) {
    const updated = await deps.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUnique({
        where: { id: runId },
        include: { steps: { orderBy: { order: "asc" } } },
      });

      if (!run) {
        throw new Error("Run not found");
      }

      const state = buildMachineState(run);
      const next = transition(state, event);

      const currentStep = run.steps[next.currentStepIndex];

      const updatedRun = await tx.run.update({
        where: { id: runId },
        data: {
          status: mapDbStatus(next.status),
          currentStepIndex: next.currentStepIndex,
          startedAt: run.startedAt ?? (next.status === "running" ? new Date() : run.startedAt),
          finishedAt: isTerminal(next.status) ? new Date() : null,
        },
      });

      if (!currentStep) {
        return {
          run: updatedRun,
          steps: run.steps,
          currentStep: null,
        };
      }

      if (next.status === "running" || next.status === "waiting_approval") {
        const stepStatus = statusForActiveStep(currentStep.kind);

        await tx.runStep.update({
          where: { id: currentStep.id },
          data: {
            status: stepStatus,
            startedAt:
              currentStep.startedAt ??
              (next.status === "running" || next.status === "waiting_approval" ? new Date() : currentStep.startedAt),
          },
        });
      }

      const steps = await tx.runStep.findMany({
        where: { runId },
        orderBy: { order: "asc" },
      });

      return {
        run: updatedRun,
        steps,
        currentStep: steps[next.currentStepIndex] ?? null,
      };
    });

    await emitStatus(runId, updated.run.status);

    return updated;
  }

  async function finalizeStepSuccess(runId: string, stepId: string, output: string, sessionId: string | null) {
    await deps.prisma.$transaction(async (tx) => {
      await tx.runStep.update({
        where: { id: stepId },
        data: {
          status: "succeeded",
          output,
          finishedAt: new Date(),
        },
      });

      await tx.run.update({
        where: { id: runId },
        data: {
          sessionId,
        },
      });
    });

    await deps.eventHub.emit(runId, "step.completed", {
      stepId,
      status: "succeeded",
      output,
    });
  }

  async function finalizeStepFailure(runId: string, stepId: string, message: string) {
    await deps.prisma.$transaction(async (tx) => {
      await tx.runStep.update({
        where: { id: stepId },
        data: {
          status: "failed",
          error: message,
          finishedAt: new Date(),
        },
      });

      await tx.run.update({
        where: { id: runId },
        data: {
          error: message,
          status: "failed",
          finishedAt: new Date(),
        },
      });
    });

    await deps.eventHub.emit(runId, "run.failed", { message });
    await deps.eventHub.emit(runId, "run.status_changed", { status: "failed" });
  }

  async function markApprovalRequested(runId: string, stepId: string) {
    await deps.prisma.runStep.update({
      where: { id: stepId },
      data: {
        status: "waiting_approval",
        startedAt: new Date(),
      },
    });

    await deps.eventHub.emit(runId, "approval.requested", {
      stepId,
    });
  }

  async function executeRun(runId: string): Promise<void> {
    const execution = executions.get(runId);

    if (!execution || execution.running === false) {
      return;
    }

    const run = await loadRun(deps.prisma, runId);

    if (!run) {
      executions.delete(runId);
      return;
    }

    if (run.status === "queued") {
      await applyTransition(runId, { type: "START" });
      return executeRun(runId);
    }

    if (run.status === "waiting_approval") {
      return;
    }

    if (run.status === "failed" || run.status === "succeeded") {
      executions.delete(runId);
      return;
    }

    const currentStep = run.steps[run.currentStepIndex];

    if (!currentStep) {
      executions.delete(runId);
      return;
    }

    if (currentStep.kind === "approval") {
      await applyTransition(runId, { type: "AWAIT_APPROVAL" });
      await markApprovalRequested(runId, currentStep.id);
      return;
    }

    try {
      await deps.eventHub.emit(runId, "step.started", {
        stepId: currentStep.id,
        order: currentStep.order,
        title: currentStep.title,
      });

      const result = await deps.promptStepRunner({
        prompt: currentStep.prompt ?? "",
        sessionId: run.sessionId,
        onLog: async (chunk) => {
          await deps.eventHub.emit(runId, "step.log", {
            stepId: currentStep.id,
            chunk,
          });
        },
      });

      await finalizeStepSuccess(runId, currentStep.id, result.output, result.sessionId);
      const after = await applyTransition(runId, { type: "STEP_SUCCEEDED" });

      if (after.run.status === "succeeded") {
        await deps.eventHub.emit(runId, "run.completed", { runId });
        executions.delete(runId);
        return;
      }

      await executeRun(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown execution error";

      await deps.eventHub.emit(runId, "step.log", {
        stepId: currentStep.id,
        chunk: `[runtime-error] ${message}`,
      });

      await finalizeStepFailure(runId, currentStep.id, message);
      executions.delete(runId);
    }
  }

  function scheduleExecution(runId: string) {
    setTimeout(() => {
      void executeRun(runId);
    }, AUTO_EXECUTE_DELAY_MS);
  }

  return {
    async listRuns(): Promise<Run[]> {
      const runs = await deps.prisma.run.findMany({
        include: { steps: { orderBy: { order: "asc" } } },
        orderBy: { createdAt: "desc" },
      });

      return runs.map(mapRun);
    },

    async getRunById(runId: string): Promise<Run | null> {
      return loadMappedRun(runId);
    },

    async createRun(input: unknown): Promise<Run> {
      const parsed = CreateRunInputSchema.parse(input);

      const workflow = await deps.prisma.workflow.findUnique({
        where: { id: parsed.workflowId },
        include: { steps: { orderBy: { order: "asc" } } },
      });

      if (!workflow) {
        throw new Error("Workflow not found");
      }

      if (workflow.steps.length === 0) {
        throw new Error("Workflow has no steps");
      }

      const created = await deps.prisma.$transaction(async (tx) => {
        const run = await tx.run.create({
          data: {
            workflowId: workflow.id,
            status: "queued",
            currentStepIndex: 0,
          },
        });

        await tx.runStep.createMany({
          data: workflow.steps.map((step) => ({
            runId: run.id,
            workflowStepId: step.id,
            order: step.order,
            title: step.title,
            kind: step.kind,
            prompt: step.prompt,
            status: "pending",
          })),
        });

        const fullRun = await tx.run.findUniqueOrThrow({
          where: { id: run.id },
          include: { steps: { orderBy: { order: "asc" } } },
        });

        return fullRun;
      });

      executions.set(created.id, { running: true });
      await deps.eventHub.emit(created.id, "run.status_changed", { status: "queued" });
      scheduleExecution(created.id);

      return mapRun(created);
    },

    async decideApproval(runId: string, input: unknown): Promise<ApprovalCheckpoint> {
      const parsed = ApproveRunInputSchema.parse(input);

      const run = await deps.prisma.run.findUnique({
        where: { id: runId },
        include: { steps: { orderBy: { order: "asc" } } },
      });

      if (!run) {
        throw new Error("Run not found");
      }

      if (run.status !== "waiting_approval") {
        throw new Error("Run is not waiting for approval");
      }

      const step = run.steps[run.currentStepIndex];

      if (!step) {
        throw new Error("Current run step not found");
      }

      const decision = parsed.decision as ApprovalDecisionType;

      const approval = await deps.prisma.$transaction(async (tx) => {
        const created = await tx.approvalDecision.create({
          data: {
            runId,
            runStepId: step.id,
            decision,
            comment: parsed.comment ?? null,
          },
        });

        await tx.runStep.update({
          where: { id: step.id },
          data: {
            status: decision === "approved" ? "approved" : "rejected",
            finishedAt: new Date(),
          },
        });

        const state = buildMachineState(run);
        const next = transition(state, { type: "APPROVAL_DECIDED", decision: parsed.decision });

        await tx.run.update({
          where: { id: runId },
          data: {
            status: next.status,
            currentStepIndex: next.currentStepIndex,
            error: parsed.decision === "rejected" ? "Run rejected at approval checkpoint" : null,
            finishedAt: next.status === "failed" || next.status === "succeeded" ? new Date() : null,
          },
        });

        if (parsed.decision === "approved") {
          const nextStep = run.steps[next.currentStepIndex];
          if (nextStep && nextStep.id !== step.id) {
            await tx.runStep.update({
              where: { id: nextStep.id },
              data: {
                status: nextStep.kind === "approval" ? "waiting_approval" : "running",
                startedAt: new Date(),
              },
            });
          }
        }

        return created;
      });

      await deps.eventHub.emit(runId, "approval.decided", {
        stepId: step.id,
        decision: parsed.decision,
        comment: parsed.comment ?? null,
      });

      if (parsed.decision === "rejected") {
        await deps.eventHub.emit(runId, "run.failed", {
          message: "Run rejected at approval checkpoint",
        });
        await deps.eventHub.emit(runId, "run.status_changed", { status: "failed" });
        executions.delete(runId);
      } else {
        await deps.eventHub.emit(runId, "run.status_changed", { status: "running" });
        executions.set(runId, { running: true });
        scheduleExecution(runId);
      }

      return mapApprovalCheckpoint(approval);
    },
  };
}
