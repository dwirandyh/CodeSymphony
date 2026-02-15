import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createEventHub } from "../src/events/eventHub";
import { createRunService } from "../src/services/runService";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "file:./test.db",
    },
  },
});

describe("run service approvals", () => {
  beforeEach(async () => {
    await prisma.runEvent.deleteMany();
    await prisma.approvalDecision.deleteMany();
    await prisma.runStep.deleteMany();
    await prisma.run.deleteMany();
    await prisma.workflowStep.deleteMany();
    await prisma.workflow.deleteMany();
  });

  it("pauses at approval and resumes when approved", async () => {
    const workflow = await prisma.workflow.create({
      data: {
        name: "approval flow",
        steps: {
          create: [
            {
              order: 0,
              title: "Step 1",
              kind: "prompt",
              prompt: "one",
            },
            {
              order: 1,
              title: "Approval",
              kind: "approval",
              prompt: null,
            },
            {
              order: 2,
              title: "Step 2",
              kind: "prompt",
              prompt: "two",
            },
          ],
        },
      },
      include: { steps: true },
    });

    const runService = createRunService({
      prisma,
      eventHub: createEventHub(prisma),
      promptStepRunner: async ({ prompt }) => ({
        output: `out:${prompt}`,
        sessionId: "session-test",
      }),
    });

    const run = await runService.createRun({ workflowId: workflow.id });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const waiting = await runService.getRunById(run.id);
    expect(waiting?.status).toBe("waiting_approval");

    await runService.decideApproval(run.id, { decision: "approved" });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const completed = await runService.getRunById(run.id);
    expect(completed?.status).toBe("succeeded");
  });

  it("fails run when approval rejected", async () => {
    const workflow = await prisma.workflow.create({
      data: {
        name: "reject flow",
        steps: {
          create: [
            {
              order: 0,
              title: "Step 1",
              kind: "prompt",
              prompt: "one",
            },
            {
              order: 1,
              title: "Approval",
              kind: "approval",
              prompt: null,
            },
          ],
        },
      },
    });

    const runService = createRunService({
      prisma,
      eventHub: createEventHub(prisma),
      promptStepRunner: async ({ prompt }) => ({
        output: `out:${prompt}`,
        sessionId: null,
      }),
    });

    const run = await runService.createRun({ workflowId: workflow.id });

    await new Promise((resolve) => setTimeout(resolve, 80));

    await runService.decideApproval(run.id, { decision: "rejected" });

    const failed = await runService.getRunById(run.id);
    expect(failed?.status).toBe("failed");
  });
});
