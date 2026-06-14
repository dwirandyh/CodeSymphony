import type { FastifyInstance } from "fastify";
import {
  handleRegisteredCursorSdkPermissionHook,
  type CursorSdkPermissionHookInput,
} from "../cursor/sdk/permissionsBridge.js";

type PermissionRouteParams = {
  token: string;
};

export async function registerCursorSdkPermissionRoutes(app: FastifyInstance) {
  app.post<{ Params: PermissionRouteParams; Body: CursorSdkPermissionHookInput }>(
    "/cursor-sdk/permissions/:token",
    async (request, reply) => {
      const result = await handleRegisteredCursorSdkPermissionHook(
        request.params.token,
        request.body,
      );

      if (!result) {
        reply.code(404).send({ error: "Cursor SDK permission bridge not found" });
        return;
      }

      reply.send(result);
    },
  );
}
