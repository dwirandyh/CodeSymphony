import type { FastifyInstance } from "fastify";
import {
  FilesystemBrowseQuerySchema,
  FilesystemReadAttachmentsInputSchema,
  FilesystemWriteTerminalDropFilesInputSchema,
} from "@codesymphony/shared-types";

export async function registerFilesystemRoutes(app: FastifyInstance) {
  app.get("/filesystem/browse", async (request, reply) => {
    try {
      const query = FilesystemBrowseQuerySchema.parse(request.query);
      const result = await app.filesystemService.browse(query.path);
      return { data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to browse filesystem";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/filesystem/attachments/read", async (request, reply) => {
    try {
      const input = FilesystemReadAttachmentsInputSchema.parse(request.body);
      const attachments = await app.filesystemService.readAttachments(input.paths);
      return { data: { attachments } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read dropped files";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/filesystem/terminal-drop/write", { bodyLimit: 30 * 1024 * 1024 }, async (request, reply) => {
    try {
      const input = FilesystemWriteTerminalDropFilesInputSchema.parse(request.body);
      const files = await app.filesystemService.writeTerminalDropFiles(input.sessionId, input.files);
      return { data: { files } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to write dropped terminal files";
      return reply.code(400).send({ error: message });
    }
  });
}
