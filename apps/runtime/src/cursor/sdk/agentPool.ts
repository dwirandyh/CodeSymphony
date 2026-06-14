import { Agent, type AgentOptions, type ModelSelection, type SDKAgent } from "@cursor/sdk";

export const CURSOR_SDK_AGENT_IDLE_TIMEOUT_MS = 2 * 60_000;

type PooledCursorSdkAgent = {
  agent: SDKAgent;
  agentId: string;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAtMs: number;
};

export type CursorSdkAgentLease = {
  agent: SDKAgent;
  agentId: string;
  release: () => void;
};

export type AcquireCursorSdkAgentParams = {
  sessionId: string | null;
  cwd: string | string[];
  apiKey: string;
  model?: ModelSelection;
  mcpServers?: AgentOptions["mcpServers"];
  mode?: AgentOptions["mode"];
  settingSources?: NonNullable<AgentOptions["local"]>["settingSources"];
  idleTimeoutMs?: number;
  ephemeral?: boolean;
  onSessionId?: (sessionId: string) => Promise<void> | void;
};

const pooledCursorSdkAgentsByAgentId = new Map<string, PooledCursorSdkAgent>();

export function isLegacyCursorAcpSessionId(id: string): boolean {
  return id.startsWith("cursor-session-") || !id.startsWith("agent-");
}

export async function acquireCursorSdkAgent(params: AcquireCursorSdkAgentParams): Promise<CursorSdkAgentLease> {
  const requestedAgentId = params.sessionId && !isLegacyCursorAcpSessionId(params.sessionId)
    ? params.sessionId
    : null;
  const idleTimeoutMs = params.idleTimeoutMs ?? CURSOR_SDK_AGENT_IDLE_TIMEOUT_MS;
  const existing = !params.ephemeral && requestedAgentId
    ? pooledCursorSdkAgentsByAgentId.get(requestedAgentId)
    : null;

  if (existing && !existing.busy) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    existing.busy = true;
    existing.lastUsedAtMs = Date.now();
    await params.onSessionId?.(existing.agentId);
    return createLease(existing, idleTimeoutMs);
  }

  const options = buildAgentOptions(params);
  const agent = requestedAgentId
    ? await Agent.resume(requestedAgentId, options)
    : await Agent.create(options);
  const pooled: PooledCursorSdkAgent = {
    agent,
    agentId: agent.agentId,
    busy: true,
    idleTimer: null,
    lastUsedAtMs: Date.now(),
  };

  if (!params.ephemeral) {
    pooledCursorSdkAgentsByAgentId.set(agent.agentId, pooled);
  }
  await params.onSessionId?.(agent.agentId);
  return params.ephemeral ? createEphemeralLease(pooled) : createLease(pooled, idleTimeoutMs);
}

export async function disposeAllCursorSdkAgents(): Promise<void> {
  const agents = [...pooledCursorSdkAgentsByAgentId.values()];
  pooledCursorSdkAgentsByAgentId.clear();

  await Promise.all(agents.map(async (pooled) => {
    if (pooled.idleTimer) {
      clearTimeout(pooled.idleTimer);
      pooled.idleTimer = null;
    }
    await disposeAgent(pooled.agent);
  }));
}

function buildAgentOptions(params: AcquireCursorSdkAgentParams): AgentOptions {
  return {
    apiKey: params.apiKey,
    ...(params.model ? { model: params.model } : {}),
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.mode ? { mode: params.mode } : {}),
    local: {
      cwd: params.cwd,
      ...(params.settingSources ? { settingSources: params.settingSources } : {}),
    },
  };
}

function createLease(pooled: PooledCursorSdkAgent, idleTimeoutMs: number): CursorSdkAgentLease {
  let released = false;

  return {
    agent: pooled.agent,
    agentId: pooled.agentId,
    release: () => {
      if (released) {
        return;
      }

      released = true;
      pooled.busy = false;
      pooled.lastUsedAtMs = Date.now();
      pooled.idleTimer = setTimeout(() => {
        pooledCursorSdkAgentsByAgentId.delete(pooled.agentId);
        void disposeAgent(pooled.agent);
      }, idleTimeoutMs);
    },
  };
}

async function disposeAgent(agent: SDKAgent): Promise<void> {
  await agent[Symbol.asyncDispose]();
}

function createEphemeralLease(pooled: PooledCursorSdkAgent): CursorSdkAgentLease {
  let released = false;

  return {
    agent: pooled.agent,
    agentId: pooled.agentId,
    release: () => {
      if (released) {
        return;
      }

      released = true;
      void disposeAgent(pooled.agent);
    },
  };
}
