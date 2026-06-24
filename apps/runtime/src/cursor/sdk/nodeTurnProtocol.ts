import type { ModelSelection } from "@cursor/sdk";
import type { AgentTodoItem } from "@codesymphony/shared-types";
import type { ChatAgentRunnerResult } from "../../types.js";

export type CursorSdkNodeTurnRequest = {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  apiKey: string;
  permissionMode?: "default" | "plan";
  threadPermissionMode?: "default" | "full_access";
  model?: ModelSelection;
  mcpServerNames: string[];
};

export type CursorSdkNodeTurnOutboundMessage =
  | { type: "ready" }
  | { type: "agent_id"; agentId: string }
  | { type: "onText"; text: string }
  | { type: "onToolStarted"; payload: Record<string, unknown> }
  | { type: "onToolOutput"; payload: Record<string, unknown> }
  | { type: "onToolFinished"; payload: Record<string, unknown> }
  | { type: "onThinking"; thinking: boolean }
  | { type: "onTodoUpdate"; payload: Record<string, unknown> }
  | { type: "onPlanFileDetected"; payload: Record<string, unknown> }
  | { type: "question_request"; requestId: string; questions: unknown }
  | { type: "done"; result: ChatAgentRunnerResult }
  | { type: "error"; message: string; name?: string | null; code?: string | null };

export type CursorSdkNodeTurnInboundMessage =
  | { type: "run"; request: CursorSdkNodeTurnRequest }
  | { type: "question_response"; requestId: string; answers: Record<string, string> }
  | { type: "cancel" };

export type SerializedCursorSdkTodoUpdate = {
  agent: "cursor";
  groupId: string;
  explanation: string | null;
  anchorToolUseId: string;
  items: AgentTodoItem[];
};