import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Cursor SDK MCP servers", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("maps Cursor mcp.json to SDK mcpServers shape", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "cursor-sdk-mcp-home-"));
    await mkdir(join(tempHome, ".cursor"), { recursive: true });
    await writeFile(join(tempHome, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: {
        Context7: {
          url: "https://mcp.context7.com/mcp",
          headers: {
            Authorization: "Bearer token",
          },
        },
        maestro: {
          command: "maestro",
          args: ["mcp"],
          env: {
            MAESTRO_DRIVER_STARTUP_TIMEOUT: "60000",
          },
        },
        disabled: {
          command: "skip-me",
          disabled: true,
        },
      },
    }));
    vi.stubEnv("HOME", tempHome);

    const { loadCursorSdkMcpServers } = await import("../src/cursor/sdk/mcpServers");

    expect(loadCursorSdkMcpServers()).toEqual({
      Context7: {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        headers: {
          Authorization: "Bearer token",
        },
      },
      maestro: {
        type: "stdio",
        command: "maestro",
        args: ["mcp"],
        env: {
          MAESTRO_DRIVER_STARTUP_TIMEOUT: "60000",
        },
      },
    });
  });
});
