import type { ApprovePlanInput, ApprovePlanResult } from "@codesymphony/shared-types";
import { hasSameThreadSelection, resolveApprovedPlanExecutionKind } from "@codesymphony/shared-types";
import type { RuntimeDeps } from "../../types.js";
import type { PendingPlanEntry } from "./chatService.types.js";
import { buildPendingPlanUpdate, loadPendingPlan } from "./chatPendingPlanState.js";
import {
  buildSelectionUpdate,
  isProviderBackedClaudeSelection,
  resolvePersistedThreadProvider,
  resolveThreadSelection,
} from "./threadSelection.js";

export async function approvePlanExecution(params: {
  deps: RuntimeDeps;
  threadId: string;
  input: ApprovePlanInput;
  isThreadActive: (threadId: string) => boolean;
  emitThreadWorkspaceUpdate: (threadId: string) => Promise<void>;
  seedHandoffThreadWithApprovedPlan: (threadId: string, plan: PendingPlanEntry) => Promise<void>;
  scheduleAssistant: (threadId: string, prompt: string, autoAcceptTools?: boolean) => void;
}): Promise<ApprovePlanResult> {
  const thread = await params.deps.prisma.chatThread.findUnique({ where: { id: params.threadId } });
  if (!thread) {
    throw new Error("Chat thread not found");
  }

  const plan = await loadPendingPlan({
    deps: params.deps,
    thread,
  });
  if (!plan) {
    throw new Error("No pending plan to approve for this thread");
  }

  if (params.isThreadActive(params.threadId)) {
    throw new Error("Assistant is still processing");
  }

  const selection = await resolveThreadSelection(params.deps, params.input);
  const messageCount = await params.deps.prisma.chatMessage.count({
    where: { threadId: params.threadId },
  });
  const currentProvider = await resolvePersistedThreadProvider(params.deps, thread);
  const selectionChanged = !hasSameThreadSelection(thread, selection);
  const executionKind = resolveApprovedPlanExecutionKind({
    requestedExecutionKind: params.input.executionKind,
    messageCount,
    threadKind: thread.kind,
    sourceAgent: thread.agent,
    sourceModelProviderId: thread.modelProviderId,
    sourceProviderHasBaseUrl: isProviderBackedClaudeSelection({
      agent: thread.agent,
      provider: currentProvider,
    }),
    targetAgent: selection.agent,
    targetModelProviderId: selection.modelProviderId,
  });
  const handoffRequired = executionKind === "handoff";

  let selectionUpdate = null;
  if (!handoffRequired && selectionChanged) {
    selectionUpdate = buildSelectionUpdate(selection, {
      resetSessionIds: messageCount === 0,
    });
  }

  let executionThreadId = params.threadId;

  if (handoffRequired) {
    const executionThread = await params.deps.prisma.chatThread.create({
      data: {
        worktreeId: thread.worktreeId,
        title: thread.title,
        kind: "default",
        permissionProfile: thread.permissionProfile,
        permissionMode: thread.permissionMode,
        mode: "default",
        handoffSourceThreadId: params.threadId,
        handoffSourcePlanEventId: plan.eventId,
        ...buildSelectionUpdate(selection),
      },
    });
    executionThreadId = executionThread.id;

    if (params.deps.workspaceEventHub) {
      params.deps.workspaceEventHub.emit("thread.created", {
        worktreeId: executionThread.worktreeId,
        threadId: executionThread.id,
      });
    }

    await params.deps.prisma.chatThread.update({
      where: { id: params.threadId },
      data: {
        mode: "default",
        ...buildPendingPlanUpdate(null),
      },
    });
    await params.seedHandoffThreadWithApprovedPlan(executionThread.id, plan);
    await params.emitThreadWorkspaceUpdate(params.threadId);
  } else {
    await params.deps.prisma.chatThread.update({
      where: { id: params.threadId },
      data: {
        mode: "default",
        ...buildPendingPlanUpdate(null),
        ...(selectionUpdate ?? {}),
      },
    });
    await params.emitThreadWorkspaceUpdate(params.threadId);
  }

  await params.deps.eventHub.emit(params.threadId, "plan.approved", {
    filePath: plan.filePath,
  });

  const executePrompt = `The user has approved the following plan. Please execute it now:\n\n${plan.content}`;
  params.scheduleAssistant(executionThreadId, executePrompt, true);

  return {
    executionKind,
    sourceThreadId: params.threadId,
    executionThreadId,
  };
}
