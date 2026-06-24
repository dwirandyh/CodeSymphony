import { Agent, type RunStatus } from "@cursor/sdk";

const TERMINAL_CURSOR_SDK_RUN_STATUSES = new Set<RunStatus | string>([
  "finished",
  "error",
  "cancelled",
  "expired",
]);

function isNonTerminalCursorSdkRunStatus(status: RunStatus | string): boolean {
  return !TERMINAL_CURSOR_SDK_RUN_STATUSES.has(status);
}

export async function reconcileStaleCursorSdkRunsBeforeSend(params: {
  agentId: string;
  cwd: string;
}): Promise<void> {
  const runs = await Agent.listRuns(params.agentId, {
    runtime: "local",
    cwd: params.cwd,
  });

  for (const listed of runs.items) {
    if (!isNonTerminalCursorSdkRunStatus(listed.status)) {
      continue;
    }

    await Agent.cancelRun(listed.id, { runtime: "local", cwd: params.cwd });
    const run = await Agent.getRun(listed.id, { runtime: "local", cwd: params.cwd });
    await run.wait();
  }
}