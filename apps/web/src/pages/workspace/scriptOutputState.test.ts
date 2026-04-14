import { describe, expect, it } from "vitest";
import type { ScriptOutputEntry } from "../../components/workspace/ScriptOutputTab";
import type { ScriptUpdateEvent } from "./hooks/useRepositoryManager";
import {
  appendScriptOutputChunk,
  clearLifecycleScriptOutputs,
  upsertScriptOutputEntry,
} from "./scriptOutputState";

function makeEntry(overrides: Partial<ScriptOutputEntry> = {}): ScriptOutputEntry {
  return {
    id: "wt-1-setup",
    worktreeId: "wt-1",
    worktreeName: "feature",
    type: "setup",
    timestamp: 1,
    output: "Installing deps...\n",
    success: true,
    status: "completed",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ScriptUpdateEvent> = {}): ScriptUpdateEvent {
  return {
    worktreeId: "wt-1",
    worktreeName: "feature",
    type: "setup",
    status: "running",
    ...overrides,
  };
}

describe("scriptOutputState", () => {
  it("preserves streamed output when a running setup finishes without a final payload body", () => {
    const runningEntries = [
      makeEntry({
        status: "running",
        output: "Installing deps...\nDone.\n",
      }),
    ];

    const next = upsertScriptOutputEntry(
      runningEntries,
      makeEvent({
        status: "completed",
        result: { success: true, output: "" },
      }),
    );

    expect(next[0]?.output).toBe("Installing deps...\nDone.\n");
    expect(next[0]?.status).toBe("completed");
    expect(next[0]?.success).toBe(true);
  });

  it("does not preserve output from a previous completed setup when a rerun starts", () => {
    const previous = [makeEntry({ output: "Old output\n", status: "completed" })];

    const next = upsertScriptOutputEntry(previous, makeEvent());

    expect(next[0]?.output).toBe("");
    expect(next[0]?.status).toBe("running");
  });

  it("appends chunks only to running entries for the same worktree", () => {
    const previous = [
      makeEntry({ status: "running", output: "Line 1\n" }),
      makeEntry({
        id: "wt-2-setup",
        worktreeId: "wt-2",
        output: "Other\n",
        status: "running",
      }),
    ];

    const next = appendScriptOutputChunk(previous, {
      worktreeId: "wt-1",
      chunk: "Line 2\n",
    });

    expect(next[0]?.output).toBe("Line 1\nLine 2\n");
    expect(next[1]?.output).toBe("Other\n");
  });

  it("clears setup and teardown history before rerun", () => {
    const previous = [
      makeEntry(),
      makeEntry({
        id: "wt-1-teardown",
        type: "teardown",
        output: "Removing temp files\n",
      }),
      makeEntry({
        id: "wt-1-run",
        type: "run",
        output: "npm run dev\n",
      }),
      makeEntry({
        id: "wt-2-setup",
        worktreeId: "wt-2",
        output: "Keep me\n",
      }),
    ];

    const next = clearLifecycleScriptOutputs(previous, "wt-1");

    expect(next).toHaveLength(2);
    expect(next.map((entry) => entry.id)).toEqual(["wt-1-run", "wt-2-setup"]);
  });
});
