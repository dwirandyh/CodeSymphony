import type { McpServerConfig } from "@cursor/sdk";
import { loadCursorRuntimeMcpConfig } from "../../acp/mcpServers.js";

export function loadCursorSdkMcpServers(): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(loadCursorRuntimeMcpConfig()).map(([name, server]) => {
      if (server.type === "http") {
        return [name, {
          type: "http" as const,
          url: server.url,
          headers: server.headers,
        }];
      }

      return [name, {
        type: "stdio" as const,
        command: server.command,
        args: server.args,
        env: server.env,
      }];
    }),
  );
}
