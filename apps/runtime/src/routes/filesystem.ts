import type { FastifyInstance } from "fastify";
import { FilesystemBrowseQuerySchema } from "@codesymphony/shared-types";

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
}
