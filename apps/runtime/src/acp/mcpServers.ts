import type { McpServer } from "@agentclientprotocol/sdk";
import type { Config as OpencodeConfig } from "@opencode-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type JsonRecord = Record<string, unknown>;
type OpencodeMcpConfig = NonNullable<OpencodeConfig["mcp"]>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveHomeDirectory(): string | null {
  const homeDirectory = process.env.HOME?.trim();
  return homeDirectory && homeDirectory.length > 0 ? homeDirectory : null;
}

function readJsonObject(filePath: string): JsonRecord | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function toHeaders(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function toEnvVariables(environment: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(environment).map(([name, value]) => ({ name, value }));
}

function loadCursorMcpConfigFile(): JsonRecord | null {
  const homeDirectory = resolveHomeDirectory();
  if (!homeDirectory) {
    return null;
  }

  return readJsonObject(join(homeDirectory, ".cursor", "mcp.json"));
}

export function loadCursorAcpMcpServers(): McpServer[] {
  const parsed = loadCursorMcpConfigFile();
  const rawServers = parsed && isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
  if (!rawServers) {
    return [];
  }

  return Object.entries(rawServers).flatMap(([name, rawServer]) => {
    if (!isRecord(rawServer) || rawServer.disabled === true) {
      return [];
    }

    const url = typeof rawServer.url === "string" ? rawServer.url.trim() : "";
    if (url.length > 0) {
      return [{
        type: "http" as const,
        name,
        url,
        headers: toHeaders(toStringRecord(rawServer.headers)),
      }];
    }

    const command = typeof rawServer.command === "string" ? rawServer.command.trim() : "";
    if (command.length === 0) {
      return [];
    }

    return [{
      name,
      command,
      args: toStringArray(rawServer.args),
      env: toEnvVariables(toStringRecord(rawServer.env)),
    }];
  });
}

function loadOpencodeConfigFile(): JsonRecord | null {
  const homeDirectory = resolveHomeDirectory();
  if (!homeDirectory) {
    return null;
  }

  return readJsonObject(join(homeDirectory, ".config", "opencode", "opencode.json"));
}

function normalizeOpencodeMcpConfigEntry(rawServer: unknown): OpencodeMcpConfig[string] | null {
  if (!isRecord(rawServer) || rawServer.enabled === false) {
    return null;
  }

  if (rawServer.type === "remote") {
    const url = typeof rawServer.url === "string" ? rawServer.url.trim() : "";
    if (url.length === 0) {
      return null;
    }

    const normalizedHeaders = toStringRecord(rawServer.headers);
    return {
      type: "remote",
      url,
      enabled: true,
      ...(Object.keys(normalizedHeaders).length > 0 ? { headers: normalizedHeaders } : {}),
      ...(typeof rawServer.timeout === "number" ? { timeout: rawServer.timeout } : {}),
      ...(rawServer.oauth === false || isRecord(rawServer.oauth) ? { oauth: rawServer.oauth } : {}),
    };
  }

  if (rawServer.type === "local") {
    const command = toStringArray(rawServer.command);
    if (command.length === 0) {
      return null;
    }

    const normalizedEnvironment = toStringRecord(rawServer.environment);
    return {
      type: "local",
      command,
      enabled: true,
      ...(Object.keys(normalizedEnvironment).length > 0 ? { environment: normalizedEnvironment } : {}),
      ...(typeof rawServer.timeout === "number" ? { timeout: rawServer.timeout } : {}),
    };
  }

  return null;
}

export function loadOpencodeRuntimeMcpConfig(): OpencodeMcpConfig | undefined {
  const parsed = loadOpencodeConfigFile();
  const rawMcp = parsed && isRecord(parsed.mcp) ? parsed.mcp : null;
  if (!rawMcp) {
    return undefined;
  }

  const normalizedEntries = Object.entries(rawMcp)
    .map(([name, rawServer]) => {
      const normalized = normalizeOpencodeMcpConfigEntry(rawServer);
      return normalized ? [name, normalized] as const : null;
    })
    .filter((entry): entry is readonly [string, OpencodeMcpConfig[string]] => entry !== null);

  if (normalizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(normalizedEntries);
}

export function loadOpencodeAcpMcpServers(): McpServer[] {
  const mcpConfig = loadOpencodeRuntimeMcpConfig();
  if (!mcpConfig) {
    return [];
  }

  return Object.entries(mcpConfig).flatMap(([name, server]) => {
    if (server.enabled === false) {
      return [];
    }

    if (server.type === "remote") {
      return [{
        type: "http" as const,
        name,
        url: server.url,
        headers: toHeaders(server.headers ?? {}),
      }];
    }

    const [command, ...args] = server.command;
    if (!command) {
      return [];
    }

    return [{
      name,
      command,
      args,
      env: toEnvVariables(server.environment ?? {}),
    }];
  });
}
