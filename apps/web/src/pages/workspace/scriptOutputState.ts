import type { ScriptOutputEntry } from "../../components/workspace/ScriptOutputTab";
import type { ScriptUpdateEvent } from "./hooks/useRepositoryManager";

export function upsertScriptOutputEntry(
  previous: ScriptOutputEntry[],
  event: ScriptUpdateEvent,
): ScriptOutputEntry[] {
  const entryId = `${event.worktreeId}-${event.type}`;
  const nextEntry: ScriptOutputEntry = {
    id: entryId,
    worktreeId: event.worktreeId,
    worktreeName: event.worktreeName,
    type: event.type,
    timestamp: Date.now(),
    output: event.result?.output ?? "",
    success: event.result?.success ?? false,
    status: event.status,
  };

  const existingIndex = previous.findIndex((entry) => entry.id === entryId);
  if (existingIndex < 0) {
    return [...previous, nextEntry];
  }

  const existingEntry = previous[existingIndex];
  const nextOutput =
    nextEntry.status === "completed" && nextEntry.output.length === 0 && existingEntry.status === "running"
      ? existingEntry.output
      : nextEntry.output;

  const updatedEntry: ScriptOutputEntry = {
    ...existingEntry,
    ...nextEntry,
    output: nextOutput,
    timestamp: nextEntry.status === "running" ? Date.now() : existingEntry.timestamp,
  };

  return previous.map((entry, index) => (index === existingIndex ? updatedEntry : entry));
}

export function appendScriptOutputChunk(
  previous: ScriptOutputEntry[],
  event: { worktreeId: string; chunk: string },
): ScriptOutputEntry[] {
  return previous.map((entry) =>
    entry.worktreeId === event.worktreeId && entry.status === "running"
      ? { ...entry, output: entry.output + event.chunk }
      : entry,
  );
}

export function clearLifecycleScriptOutputs(
  previous: ScriptOutputEntry[],
  worktreeId: string,
): ScriptOutputEntry[] {
  return previous.filter(
    (entry) =>
      entry.worktreeId !== worktreeId
      || (entry.type !== "setup" && entry.type !== "teardown"),
  );
}
