import type { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  AgentConfig,
  UpdateAgentConfigInput,
} from "@codesymphony/shared-types";

const SINGLETON_ID = "singleton";

export type ResolvedAgentConfig = {
  claudePath: string | null;
  codexPath: string | null;
  opencodePath: string | null;
  cursorApiKey: string | null;
};

const EMPTY_RESOLVED: ResolvedAgentConfig = {
  claudePath: null,
  codexPath: null,
  opencodePath: null,
  cursorApiKey: null,
};

let resolvedCache: ResolvedAgentConfig = { ...EMPTY_RESOLVED };

export function getResolvedAgentConfigCached(): ResolvedAgentConfig {
  return resolvedCache;
}

export function resetResolvedAgentConfigCacheForTests(): void {
  resolvedCache = { ...EMPTY_RESOLVED };
}

export function setResolvedAgentConfigCacheForTests(
  partial: Partial<ResolvedAgentConfig>,
): void {
  resolvedCache = { ...EMPTY_RESOLVED, ...partial };
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 11) return "••••";
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

function normalizeOptionalSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

type AgentConfigRow = {
  claudePath: string | null;
  codexPath: string | null;
  opencodePath: string | null;
  cursorApiKey: string | null;
  updatedAt: Date;
};

function toResolved(row: AgentConfigRow | null): ResolvedAgentConfig {
  if (!row) {
    return { ...EMPTY_RESOLVED };
  }
  return {
    claudePath: row.claudePath,
    codexPath: row.codexPath,
    opencodePath: row.opencodePath,
    cursorApiKey: row.cursorApiKey,
  };
}

function resolveCommandToAbsolutePath(command: string): string {
  // Already an absolute/relative path → return as-is.
  if (command.includes("/")) {
    return command;
  }
  // Resolve a bare command name (e.g. "claude") to its absolute path via `which`.
  try {
    const result = spawnSync("which", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const resolved = result.stdout?.trim().split(/\r?\n/)[0]?.trim();
    if (resolved && resolved.length > 0 && existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Fall through to returning the bare command name.
  }
  return command;
}

function resolvePathPrecedence(
  configured: string | null | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  const fromConfig = configured?.trim();
  if (fromConfig) return resolveCommandToAbsolutePath(fromConfig);
  const fromEnv = envValue?.trim();
  if (fromEnv) return resolveCommandToAbsolutePath(fromEnv);
  return resolveCommandToAbsolutePath(fallback);
}

function mapConfig(row: AgentConfigRow | null): AgentConfig {
  const cursorApiKey = row?.cursorApiKey ?? null;
  return {
    claudePath: row?.claudePath ?? null,
    codexPath: row?.codexPath ?? null,
    opencodePath: row?.opencodePath ?? null,
    claudePathResolved: resolvePathPrecedence(
      row?.claudePath,
      process.env.CLAUDE_CODE_EXECUTABLE,
      "claude",
    ),
    codexPathResolved: resolvePathPrecedence(
      row?.codexPath,
      process.env.CODEX_BINARY_PATH,
      "codex",
    ),
    opencodePathResolved: resolvePathPrecedence(
      row?.opencodePath,
      process.env.OPENCODE_BINARY_PATH,
      "opencode",
    ),
    cursorApiKeyMasked: cursorApiKey ? maskApiKey(cursorApiKey) : "",
    cursorApiKeySet: Boolean(cursorApiKey),
    updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
  };
}

export function createAgentConfigService(prisma: PrismaClient) {
  async function readRow(): Promise<AgentConfigRow | null> {
    return prisma.agentConfig.findUnique({ where: { id: SINGLETON_ID } });
  }

  function refreshCache(row: AgentConfigRow | null): void {
    resolvedCache = toResolved(row);
  }

  return {
    async loadCache(): Promise<void> {
      refreshCache(await readRow());
    },

    async getAgentConfig(): Promise<AgentConfig> {
      return mapConfig(await readRow());
    },

    async updateAgentConfig(input: UpdateAgentConfigInput): Promise<AgentConfig> {
      const data: Record<string, string | null> = {};
      if (input.claudePath !== undefined) {
        data.claudePath = normalizeOptionalSecret(input.claudePath);
      }
      if (input.codexPath !== undefined) {
        data.codexPath = normalizeOptionalSecret(input.codexPath);
      }
      if (input.opencodePath !== undefined) {
        data.opencodePath = normalizeOptionalSecret(input.opencodePath);
      }
      if (input.cursorApiKey !== undefined) {
        data.cursorApiKey = normalizeOptionalSecret(input.cursorApiKey);
      }

      const row = await prisma.agentConfig.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...data },
        update: data,
      });
      refreshCache(row);
      return mapConfig(row);
    },
  };
}

export type AgentConfigService = ReturnType<typeof createAgentConfigService>;
