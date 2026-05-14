import type { CliAgent } from "@codesymphony/shared-types";

function formatCliAgentName(agent: CliAgent): string {
  if (agent === "codex") {
    return "Codex";
  }

  if (agent === "cursor") {
    return "Cursor";
  }

  if (agent === "opencode") {
    return "OpenCode";
  }

  return "Claude";
}

function normalizeThreadTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }

  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function formatResourceMonitorAgentLabel(agent: CliAgent, threadTitle?: string | null): string {
  const agentName = formatCliAgentName(agent);
  const normalizedThreadTitle = normalizeThreadTitle(threadTitle);

  if (!normalizedThreadTitle) {
    return `Agent: ${agentName}`;
  }

  return `Agent: ${agentName} | ${normalizedThreadTitle}`;
}
