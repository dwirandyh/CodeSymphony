import type { SDKMessage } from "@cursor/sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function* messages(items: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  for (const item of items) {
    yield item;
  }
}

// Regression for dogfood ISSUE-001/002/003: the real Cursor createPlan tool call
// carries the full plan inline in args.plan with an empty {} result. The bridge
// must surface that content as the plan (not fall back to streaming narration),
// write it to disk, and expose it as tool output.
const REAL_PLAN = `# Perbaiki Explorer → Empty Editor Group

## Masalah saat ini

Flow buka file dari Explorer sudah punya hook sinkron via \`prepareEditorGroupsForExplorerFileOpen\`, tapi target group masih hardcoded ke \`topRight\`.

## Langkah

1. Tambah deteksi empty group
2. Fallback append ke topRight saat semua penuh

## Verifikasi manual

- Klik file di Explorer dengan satu group kosong → buka di group kosong
`;

describe("Cursor SDK event bridge — real createPlan payload", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "cursor-sdk-realplan-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("surfaces the inline plan, writes it to disk, and exposes it as tool output", async () => {
    const onPlanFileDetected = vi.fn();
    const onToolFinished = vi.fn();
    const { bridgeCursorSdkRunStream } = await import("../src/cursor/sdk/eventBridge");

    const result = await bridgeCursorSdkRunStream({
      cwd,
      stream: messages([
        {
          type: "tool_call",
          agent_id: "agent-1",
          run_id: "run-1",
          call_id: "tool_createplan",
          name: "createPlan",
          status: "completed",
          args: { plan: REAL_PLAN },
          result: { status: "success", value: {} },
        },
      ]),
      onText: vi.fn(),
      onToolStarted: vi.fn(),
      onToolOutput: vi.fn(),
      onToolFinished,
      onPlanFileDetected,
    });

    // ISSUE-001: plan emitted from inline content, not streaming_fallback narration
    expect(result.planEmitted).toBe(true);
    const planAbsolutePath = join(cwd, ".cursor", "plans", "cursor-plan.md");
    expect(onPlanFileDetected).toHaveBeenCalledWith(expect.objectContaining({
      filePath: planAbsolutePath,
      content: REAL_PLAN.trim(),
    }));

    // ISSUE-003: plan written to disk
    const written = await readFile(planAbsolutePath, "utf8");
    expect(written.trim()).toBe(REAL_PLAN.trim());

    // ISSUE-002: tool output carries the plan markdown, not {}
    expect(onToolFinished).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "createPlan",
      output: REAL_PLAN.trim(),
      summary: "Created plan",
    }));
    const finishedCall = onToolFinished.mock.calls.find(
      ([payload]) => payload.toolName === "createPlan",
    );
    expect(finishedCall?.[0].output).not.toBe("{}");
    expect(finishedCall?.[0].output).not.toContain("\"value\":{}");
  });
});
