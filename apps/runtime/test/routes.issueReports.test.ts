import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueReportRoutes } from "../src/routes/issueReports";

describe("issue report routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/issue-reports/directory prepares the reports directory", async () => {
    const ensureReportsDirectory = vi.fn(async () => "/tmp/codesymphony/issue-reports");
    app.decorate("issueReportService", {
      ensureReportsDirectory,
      createIssueReport: vi.fn(),
      getReportsDirectory: vi.fn(),
      getReportsDirectoryFingerprint: vi.fn(),
    } as never);
    await app.register(registerIssueReportRoutes, { prefix: "/api" });

    const res = await app.inject({
      method: "GET",
      url: "/api/issue-reports/directory",
    });

    expect(res.statusCode).toBe(200);
    expect(ensureReportsDirectory).toHaveBeenCalledOnce();
    expect(res.json()).toEqual({
      data: {
        directoryPath: "/tmp/codesymphony/issue-reports",
      },
    });
  });
});
