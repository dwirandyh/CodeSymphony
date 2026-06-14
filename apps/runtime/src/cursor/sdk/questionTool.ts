import type { SDKCustomTool, SDKCustomToolContext, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import type { ChatAgentRunner } from "../../types.js";

type RunnerArgs = Parameters<ChatAgentRunner>[0];
type QuestionRequest = RunnerArgs["onQuestionRequest"];
type QuestionPayload = Parameters<QuestionRequest>[0]["questions"];

export const CURSOR_SDK_QUESTION_TOOL_NAME = "ask_user_question";

const CURSOR_SDK_QUESTION_STEERING = [
  `IMPORTANT: When you need any clarification, decision, or missing information from the user,`,
  `you MUST call the \`${CURSOR_SDK_QUESTION_TOOL_NAME}\` tool and wait for the answer.`,
  `Never ask the user a question by writing it as plain assistant text — always use the tool so`,
  `the question is actionable. Continue normally for everything else.`,
].join(" ");

// Cursor will write questions as plain text unless explicitly steered to call
// the tool, so prepend a directive to the per-send prompt. The user's original
// prompt is preserved verbatim at the tail.
export function applyCursorSdkQuestionSteering(prompt: string): string {
  return `${CURSOR_SDK_QUESTION_STEERING}\n\n${prompt}`;
}

const QUESTION_TOOL_DESCRIPTION =
  "Ask the user one or more clarifying questions and block until they answer. "
  + "Call this whenever you need a decision or information before continuing instead of "
  + "writing the question as plain text. Provide `questions`: an array of "
  + "{ question, header?, multiSelect?, options?: [{ label, description? }] }. "
  + "The user's answers are returned in structuredContent.answers keyed by question text.";

const QUESTION_TOOL_INPUT_SCHEMA: Record<string, SDKJsonValue> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "The questions to ask the user.",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The full question text." },
          header: { type: "string", description: "Short label for the question (max ~12 chars)." },
          multiSelect: { type: "boolean", description: "Allow selecting multiple options." },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label"],
            },
          },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
};

function coerceObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeOptions(value: unknown): QuestionPayload[number]["options"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options = value
    .map((entry) => coerceObject(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => {
      const label = typeof entry.label === "string" ? entry.label : undefined;
      if (!label) {
        return null;
      }
      return typeof entry.description === "string"
        ? { label, description: entry.description }
        : { label };
    })
    .filter((entry): entry is { label: string; description?: string } => entry !== null);
  return options.length > 0 ? options : undefined;
}

function normalizeQuestion(raw: Record<string, unknown>): QuestionPayload[number] | null {
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) {
    return null;
  }
  const normalized: QuestionPayload[number] = { question };
  if (typeof raw.header === "string" && raw.header.trim().length > 0) {
    normalized.header = raw.header.trim();
  }
  if (typeof raw.multiSelect === "boolean") {
    normalized.multiSelect = raw.multiSelect;
  }
  const options = normalizeOptions(raw.options);
  if (options) {
    normalized.options = options;
  }
  return normalized;
}

// Cursor filters its native askQuestion tool out of the public message stream,
// so structured questions are surfaced via an in-process custom tool the model
// can call. Each turn binds its own onQuestionRequest (per-send customTools),
// which CodeSymphony maps to the question.requested SSE event + answer/dismiss flow.
export function buildCursorSdkQuestionTool(params: {
  onQuestionRequest: QuestionRequest;
}): SDKCustomTool {
  return {
    description: QUESTION_TOOL_DESCRIPTION,
    inputSchema: QUESTION_TOOL_INPUT_SCHEMA,
    execute: async (
      args: Record<string, SDKJsonValue>,
      context: SDKCustomToolContext,
    ): Promise<SDKCustomToolResult> => {
      const rawQuestions = Array.isArray(args.questions)
        ? args.questions
        : coerceObject(args.questions) || typeof args.question === "string"
          ? [args]
          : [];

      const questions = rawQuestions
        .map((entry) => coerceObject(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map(normalizeQuestion)
        .filter((entry): entry is QuestionPayload[number] => entry !== null);

      if (questions.length === 0) {
        return {
          content: [{ type: "text", text: "No question provided." }],
          isError: true,
        };
      }

      const requestId = typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0
        ? context.toolCallId
        : crypto.randomUUID();

      const { answers } = await params.onQuestionRequest({ requestId, questions });

      return {
        content: [{ type: "text", text: JSON.stringify(answers) }],
        structuredContent: { answers: answers as Record<string, SDKJsonValue> },
      };
    },
  };
}
