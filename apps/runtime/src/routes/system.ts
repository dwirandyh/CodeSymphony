import type { FastifyInstance } from "fastify";
import { ClipboardTextSchema, OpenInAppInputSchema } from "@codesymphony/shared-types";

export async function registerSystemRoutes(app: FastifyInstance) {
  app.post("/system/pick-directory", async (_request, reply) => {
    try {
      const result = await app.systemService.pickDirectory();
      return { data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to pick directory";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/system/clipboard", async (_request, reply) => {
    try {
      const text = await app.systemService.readClipboard();
      return { data: { text } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read the host clipboard";
      return reply.code(400).send({ error: message });
    }
  });

  app.put("/system/clipboard", async (request, reply) => {
    try {
      const input = ClipboardTextSchema.parse(request.body ?? {});
      await app.systemService.writeClipboard(input.text);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to write the host clipboard";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/system/installed-apps", async (_request, reply) => {
    try {
      const apps = await app.systemService.getInstalledApps();
      return { data: { apps } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to detect installed apps";
      return reply.code(400).send({ error: message });
    }
  });

  app.get<{ Params: { appId: string } }>("/system/installed-apps/:appId/icon", async (request, reply) => {
    try {
      const apps = await app.systemService.getInstalledApps();
      const appEntry = apps.find((entry) => entry.id === request.params.appId);
      if (!appEntry) {
        return reply.code(404).send({ error: `App not found: ${request.params.appId}` });
      }

      const icon = await app.systemService.getAppIcon(appEntry.path);
      return reply
        .header("Cache-Control", "public, max-age=3600")
        .type(icon.contentType)
        .send(icon.buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load app icon";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/system/open-in-app", async (request, reply) => {
    try {
      const input = OpenInAppInputSchema.parse(request.body);

      const apps = await app.systemService.getInstalledApps();
      const appEntry = apps.find((a) => a.id === input.appId);
      if (!appEntry) {
        return reply.code(404).send({ error: `App not found: ${input.appId}` });
      }

      await app.systemService.openInApp(appEntry.name, input.targetPath);
      return reply.code(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open in app";
      return reply.code(400).send({ error: message });
    }
  });
}
