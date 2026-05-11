import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CreateAutomationInputSchema,
  UpdateAutomationInputSchema,
} from "@codesymphony/shared-types";

const automationParams = z.object({
  id: z.string().trim().min(1),
});

const automationVersionParams = z.object({
  id: z.string().trim().min(1),
  versionId: z.string().trim().min(1),
});

const listAutomationsQuerySchema = z.object({
  repositoryId: z.string().trim().min(1).optional(),
  enabled: z.enum(["true", "false"]).optional(),
}).strict();

function respondForAutomationRouteError(
  reply: FastifyReply,
  error: unknown,
  fallbackMessage: string,
) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (
    message === "Automation not found"
    || message === "Automation prompt version not found"
  ) {
    return reply.code(404).send({ error: message });
  }

  if (
    message === "Repository not found"
    || message === "Target worktree not found"
    || message === "Invalid IANA timezone"
    || message === "Invalid RRULE"
    || message === "Unsupported RRULE frequency"
    || message === "Invalid RRULE BYHOUR"
    || message === "Invalid RRULE BYMINUTE"
  ) {
    return reply.code(400).send({ error: message });
  }

  return reply.code(400).send({ error: message });
}

export async function registerAutomationRoutes(app: FastifyInstance) {
  app.get("/automations", async (request, reply) => {
    const query = listAutomationsQuerySchema.parse(request.query);

    try {
      const automations = await app.automationService.listAutomations({
        repositoryId: query.repositoryId,
        enabled: query.enabled === undefined ? undefined : query.enabled === "true",
      });
      return { data: automations };
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to list automations");
    }
  });

  app.post("/automations", async (request, reply) => {
    const input = CreateAutomationInputSchema.parse(request.body);

    try {
      const automation = await app.automationService.createAutomation(input);
      return reply.code(201).send({ data: automation });
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to create automation");
    }
  });

  app.get("/automations/:id", async (request, reply) => {
    const params = automationParams.parse(request.params);

    try {
      const automation = await app.automationService.getAutomation(params.id);
      if (!automation) {
        return reply.code(404).send({ error: "Automation not found" });
      }
      return { data: automation };
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to load automation");
    }
  });

  app.patch("/automations/:id", async (request, reply) => {
    const params = automationParams.parse(request.params);
    const input = UpdateAutomationInputSchema.parse(request.body);

    try {
      const automation = await app.automationService.updateAutomation(params.id, input);
      return { data: automation };
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to update automation");
    }
  });

  app.delete("/automations/:id", async (request, reply) => {
    const params = automationParams.parse(request.params);

    try {
      await app.automationService.deleteAutomation(params.id);
      return reply.code(204).send();
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to delete automation");
    }
  });

  app.post("/automations/:id/run", async (request, reply) => {
    const params = automationParams.parse(request.params);

    try {
      const run = await app.automationService.runAutomationNow(params.id);
      return reply.code(202).send({ data: run });
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to run automation");
    }
  });

  app.get("/automations/:id/runs", async (request, reply) => {
    const params = automationParams.parse(request.params);

    try {
      const runs = await app.automationService.listRuns(params.id);
      return { data: runs };
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to list automation runs");
    }
  });

  app.get("/automations/:id/versions", async (request, reply) => {
    const params = automationParams.parse(request.params);

    try {
      const versions = await app.automationService.listPromptVersions(params.id);
      return { data: versions };
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to list automation prompt versions");
    }
  });

  app.post("/automations/:id/versions/:versionId/restore", async (request, reply) => {
    const params = automationVersionParams.parse(request.params);

    try {
      const automation = await app.automationService.restorePromptVersion(params.id, params.versionId);
      return { data: automation };
    } catch (error) {
      return respondForAutomationRouteError(reply, error, "Unable to restore automation prompt version");
    }
  });
}
