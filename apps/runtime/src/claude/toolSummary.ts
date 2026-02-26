import type { ToolMetadata } from "./toolClassification.js";
import { readTargetFromUnknownToolInput, editTargetFromUnknownToolInput } from "./toolClassification.js";

export function completionSummaryFromMetadata(metadata: ToolMetadata, toolInput?: unknown): string {
    if (metadata.command) {
        return `Ran ${metadata.command}`;
    }

    if (metadata.isBash) {
        return "Ran bash command";
    }

    const readTarget = metadata.readTarget ?? readTargetFromUnknownToolInput(metadata.toolName, toolInput);
    if (readTarget) {
        return `Read ${readTarget}`;
    }

    const editTarget = metadata.editTarget ?? editTargetFromUnknownToolInput(metadata.toolName, toolInput);
    if (editTarget) {
        return `Edited ${editTarget}`;
    }

    return `Completed ${metadata.toolName}`;
}

export function failureSummaryFromMetadata(metadata: ToolMetadata, toolInput: unknown, command?: string): string {
    if (command) {
        return `Failed ${command}`;
    }

    if (metadata.isBash) {
        return "Bash command failed";
    }

    const readTarget = metadata.readTarget ?? readTargetFromUnknownToolInput(metadata.toolName, toolInput);
    if (readTarget) {
        return `Failed to read ${readTarget}`;
    }

    const editTarget = metadata.editTarget ?? editTargetFromUnknownToolInput(metadata.toolName, toolInput);
    if (editTarget) {
        return `Failed to edit ${editTarget}`;
    }

    return `${metadata.toolName} failed`;
}
