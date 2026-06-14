import type { SDKMessage } from "@cursor/sdk";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function* messages(items: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const item of items) {
    yield item;
  }
}

describe("Cursor SDK event bridge", () => {
  it("bridges assistant text, thinking, and tool lifecycle callbacks", async () => {
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolStarted = vi.fn();
    const onToolOutput = vi.fn();
    const onToolFinished = vi.fn();
    const { bridgeCursorSdkRunStream } = await import("../src/cursor/sdk/eventBridge");

    const result = await bridgeCursorSdkRunStream({
      stream: messages([
        {
          type: "thinking",
          agent_id: "agent-1",
          run_id: "run-1",
          text: "thinking",
        },
        {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello " }],
          },
        },
        {
          type: "tool_call",
          agent_id: "agent-1",
          run_id: "run-1",
          call_id: "tool 1",
          name: "shell",
          status: "running",
          args: { command: "pwd" },
        },
        {
          type: "tool_call",
          agent_id: "agent-1",
          run_id: "run-1",
          call_id: "tool 1",
          name: "shell",
          status: "completed",
          args: { command: "pwd" },
          result: { stdout: "/tmp/project\n" },
        },
        {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done." }],
          },
        },
      ]),
      onText,
      onThinking,
      onToolStarted,
      onToolOutput,
      onToolFinished,
    });

    expect(result.output).toBe("Hello done.");
    expect(result.planEmitted).toBe(false);
    expect(onThinking).toHaveBeenCalledWith(true);
    expect(onText).toHaveBeenCalledWith("Hello ");
    expect(onText).toHaveBeenCalledWith("done.");
    expect(onToolStarted).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "shell",
      toolUseId: "tool1",
      parentToolUseId: null,
      command: "pwd",
      shell: "bash",
      isBash: true,
    }));
    expect(onToolOutput).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "shell",
      toolUseId: "tool1",
      parentToolUseId: null,
    }));
    expect(onToolFinished).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "shell",
      precedingToolUseIds: ["tool1"],
      command: "pwd",
      output: "/tmp/project\n",
    }));
  });

  describe("plan file detection", () => {
    let cwd: string;

    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), "cursor-sdk-plan-"));
    });

    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    it("emits onPlanFileDetected when a tool result reports a saved plan path", async () => {
      const planRelativePath = join(".cursor", "plans", "feature.plan.md");
      const planAbsolutePath = join(cwd, planRelativePath);
      await mkdir(join(cwd, ".cursor", "plans"), { recursive: true });
      await writeFile(planAbsolutePath, "# Plan\n\n- step one\n", "utf8");

      const onPlanFileDetected = vi.fn();
      const { bridgeCursorSdkRunStream } = await import("../src/cursor/sdk/eventBridge");

      await bridgeCursorSdkRunStream({
        cwd,
        stream: messages([
          {
            type: "tool_call",
            agent_id: "agent-1",
            run_id: "run-1",
            call_id: "plan 1",
            name: "Write",
            status: "completed",
            args: { path: planRelativePath },
            result: { content: `Plan saved to ${pathToFileURL(planAbsolutePath).href}` },
          },
        ]),
        onText: vi.fn(),
        onToolStarted: vi.fn(),
        onToolOutput: vi.fn(),
        onToolFinished: vi.fn(),
        onPlanFileDetected,
      });

      expect(onPlanFileDetected).toHaveBeenCalledTimes(1);
      expect(onPlanFileDetected).toHaveBeenCalledWith(expect.objectContaining({
        filePath: planAbsolutePath,
        content: "# Plan\n\n- step one",
      }));
    });

    it("detects plan files from edits to a .cursor/plans path", async () => {
      const planRelativePath = join(".cursor", "plans", "edited.plan.md");
      const planAbsolutePath = join(cwd, planRelativePath);
      await mkdir(join(cwd, ".cursor", "plans"), { recursive: true });
      await writeFile(planAbsolutePath, "# Edited plan\n", "utf8");

      const onPlanFileDetected = vi.fn();
      const { bridgeCursorSdkRunStream } = await import("../src/cursor/sdk/eventBridge");

      await bridgeCursorSdkRunStream({
        cwd,
        stream: messages([
          {
            type: "tool_call",
            agent_id: "agent-1",
            run_id: "run-1",
            call_id: "edit 1",
            name: "Edit",
            status: "completed",
            args: { path: planRelativePath },
            result: { content: "ok" },
          },
        ]),
        onText: vi.fn(),
        onToolStarted: vi.fn(),
        onToolOutput: vi.fn(),
        onToolFinished: vi.fn(),
        onPlanFileDetected,
      });

      expect(onPlanFileDetected).toHaveBeenCalledTimes(1);
      expect(onPlanFileDetected).toHaveBeenCalledWith(expect.objectContaining({
        filePath: planAbsolutePath,
        content: "# Edited plan",
      }));
    });

    it("does not emit a plan when no plan file is involved", async () => {
      const onPlanFileDetected = vi.fn();
      const { bridgeCursorSdkRunStream } = await import("../src/cursor/sdk/eventBridge");

      await bridgeCursorSdkRunStream({
        cwd,
        stream: messages([
          {
            type: "tool_call",
            agent_id: "agent-1",
            run_id: "run-1",
            call_id: "edit 2",
            name: "Edit",
            status: "completed",
            args: { path: "src/index.ts" },
            result: { content: "ok" },
          },
        ]),
        onText: vi.fn(),
        onToolStarted: vi.fn(),
        onToolOutput: vi.fn(),
        onToolFinished: vi.fn(),
        onPlanFileDetected,
      });

      expect(onPlanFileDetected).not.toHaveBeenCalled();
    });
  });
});
