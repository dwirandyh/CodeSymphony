import type { FastifyInstance } from "fastify";
import { CreateIssueReportInputSchema } from "@codesymphony/shared-types";

export async function registerIssueReportRoutes(app: FastifyInstance) {
  app.post("/issue-reports", async (request, reply) => {
    try {
      const input = CreateIssueReportInputSchema.parse(request.body ?? {});
      const report = await app.issueReportService.createIssueReport(input);
      return { data: report };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create issue report";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/issue-reports/directory", async (_request, reply) => {
    try {
      const directoryPath = await app.issueReportService.ensureReportsDirectory();
      return { data: { directoryPath } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to prepare issue reports directory";
      return reply.code(400).send({ error: message });
    }
  });
}
