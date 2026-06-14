import { describe, expect, it, vi } from "vitest";
import {
  buildCursorSdkQuestionTool,
  applyCursorSdkQuestionSteering,
  CURSOR_SDK_QUESTION_TOOL_NAME,
} from "../src/cursor/sdk/questionTool.js";

describe("Cursor SDK question tool", () => {
  it("forwards structured questions to onQuestionRequest and returns the answers", async () => {
    const onQuestionRequest = vi.fn(async () => ({
      answers: { "Pick a color": "blue" },
    }));

    const tool = buildCursorSdkQuestionTool({ onQuestionRequest });
    expect(tool.description).toMatch(/question/i);

    const result = await tool.execute(
      {
        questions: [
          {
            question: "Pick a color",
            header: "Color",
            multiSelect: false,
            options: [
              { label: "blue", description: "the sky" },
              { label: "red" },
            ],
          },
        ],
      },
      { toolCallId: "call-1" },
    );

    expect(onQuestionRequest).toHaveBeenCalledWith({
      requestId: "call-1",
      questions: [
        {
          question: "Pick a color",
          header: "Color",
          multiSelect: false,
          options: [
            { label: "blue", description: "the sky" },
            { label: "red" },
          ],
        },
      ],
    });

    // The model reads answers back from structuredContent.
    expect(result).toMatchObject({
      structuredContent: { answers: { "Pick a color": "blue" } },
    });
  });

  it("coerces a single bare question into the questions array", async () => {
    const onQuestionRequest = vi.fn(async () => ({ answers: { Q: "yes" } }));
    const tool = buildCursorSdkQuestionTool({ onQuestionRequest });

    await tool.execute({ question: "Proceed?", header: "Confirm" }, { toolCallId: "call-2" });

    expect(onQuestionRequest).toHaveBeenCalledWith({
      requestId: "call-2",
      questions: [{ question: "Proceed?", header: "Confirm" }],
    });
  });

  it("generates a request id when the SDK omits a tool call id", async () => {
    const onQuestionRequest = vi.fn(async () => ({ answers: {} }));
    const tool = buildCursorSdkQuestionTool({ onQuestionRequest });

    await tool.execute({ questions: [{ question: "Hi?" }] }, {});

    const call = onQuestionRequest.mock.calls[0]?.[0];
    expect(typeof call?.requestId).toBe("string");
    expect((call?.requestId as string).length).toBeGreaterThan(0);
  });

  it("returns an error result when no question is provided", async () => {
    const onQuestionRequest = vi.fn(async () => ({ answers: {} }));
    const tool = buildCursorSdkQuestionTool({ onQuestionRequest });

    const result = await tool.execute({ questions: [] }, { toolCallId: "call-3" });

    expect(onQuestionRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it("exposes a stable tool name", () => {
    expect(CURSOR_SDK_QUESTION_TOOL_NAME).toBe("ask_user_question");
  });
});

describe("Cursor SDK question steering", () => {
  it("prepends a directive instructing the model to use the ask tool", () => {
    const steered = applyCursorSdkQuestionSteering("Add a README note.");

    expect(steered).toContain(CURSOR_SDK_QUESTION_TOOL_NAME);
    expect(steered.endsWith("Add a README note.")).toBe(true);
    // Original prompt is preserved verbatim at the tail.
    expect(steered).toMatch(/ask_user_question[\s\S]*Add a README note\.$/);
  });

  it("keeps the user prompt intact and only adds a single directive block", () => {
    const prompt = "Do the thing.";
    const steered = applyCursorSdkQuestionSteering(prompt);

    expect(steered).not.toBe(prompt);
    expect(steered.split(prompt)).toHaveLength(2);
  });
});
