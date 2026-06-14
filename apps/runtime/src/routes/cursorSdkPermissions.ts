import type { FastifyInstance } from "fastify";
import {
  handleRegisteredCursorSdkPermissionHook,
  type CursorSdkPermissionHookInput,
} from "../cursor/sdk/permissionsBridge.js";

export async function registerCursorSdkPermissionRoutes(app: FastifyInstance) {
  app.post<{ Body: CursorSdkPermissionHookInput }>(
    "/cursor-sdk/permissions",
    async (request, reply) => {
      const result = await handleRegisteredCursorSdkPermissionHook(request.body);

      if (!result) {
        reply.code(404).send({ error: "Cursor SDK permission bridge not found" });
        return;
      }

      reply.send(result);
    },
  );
}
