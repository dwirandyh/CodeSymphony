import type { FastifyInstance } from "fastify";
import {
  TestAgentConfigInputSchema,
  UpdateAgentConfigInputSchema,
  type TestAgentConfigResult,
} from "@codesymphony/shared-types";
import { spawnSync } from "node:child_process";
import { listCursorSdkModels } from "../cursor/sdk/catalog.js";
import { getResolvedAgentConfigCached } from "../services/agentConfigService.js";

function readBinaryVersion(command: string): { ok: boolean; detail?: string; error?: string } {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return { ok: false, error: stderr || `Exited with code ${result.status}` };
  }
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { ok: true, detail: detail ?? "ok" };
}

export async function registerAgentConfigRoutes(app: FastifyInstance) {
  app.get("/settings/agents", async () => {
    const config = await app.agentConfigService.getAgentConfig();
    return { data: config };
  });

  app.put("/settings/agents", async (request, reply) => {
    try {
      const input = UpdateAgentConfigInputSchema.parse(request.body ?? {});
      const config = await app.agentConfigService.updateAgentConfig(input);
      return { data: config };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update agent config";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/settings/agents/test", async (request, reply) => {
    let input;
    try {
      input = TestAgentConfigInputSchema.parse(request.body ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid test request";
      return reply.code(400).send({ error: message });
    }

    const value = input.value.trim();
    let result: TestAgentConfigResult;

    if (input.agent === "cursor") {
      // When the field is left empty, fall back to the saved key so the user can
      // re-validate an already-stored Cursor API key without retyping it.
      const apiKey = value || getResolvedAgentConfigCached().cursorApiKey?.trim() || "";
      if (!apiKey) {
        result = { ok: false, error: "Cursor API key is required to test." };
      } else {
        try {
          const models = await listCursorSdkModels({ apiKey });
          result = { ok: true, detail: `${models.length} model(s) available` };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Cursor authentication failed";
          result = { ok: false, error: message };
        }
      }
    } else {
      const command = value || input.agent;
      result = readBinaryVersion(command);
    }

    return { data: result };
  });
}
