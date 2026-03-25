import { useCallback, useEffect, useMemo, useState } from "react";
import fuzzysort from "fuzzysort";
import type { AvailableCommand } from "@codesymphony/shared-types";
import { detectSlashCommandInEditor, getCommandNamesFromEditor, nextMentionId } from "./composerEditorUtils";
import type { SlashCommandState } from "./composerEditorUtils";
import { createCommandChipElement } from "./composerChipUtils";

type SuggestionEntry = AvailableCommand & { highlighted?: string };

export function useComposerSlashCommands({
  editorRef,
  popoverRef,
  availableCommands,
  onChange,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  availableCommands: AvailableCommand[];
  onChange: (nextValue: string) => void;
}) {
  const [slashCommand, setSlashCommand] = useState<SlashCommandState>({ active: false, query: "", startOffset: -1, anchorNode: null });
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);

  const slashSuggestions: SuggestionEntry[] = useMemo(() => {
    if (!slashCommand.active) return [];

    const editor = editorRef.current;
    const existingCommands = editor ? new Set(getCommandNamesFromEditor(editor)) : new Set<string>();
    const remainingCommands = availableCommands.filter((command) => !existingCommands.has(command.name));

    if (!slashCommand.query) {
      return remainingCommands.slice(0, 20);
    }

    const results = fuzzysort.go(slashCommand.query, remainingCommands, {
      keys: ["name", "description"],
      limit: 20,
    });
    return results.map((result) => ({
      ...result.obj,
      highlighted: result[0] ? result[0].highlight("<mark>", "</mark>") : undefined,
    }));
  }, [availableCommands, slashCommand.active, slashCommand.query, editorRef]);

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [slashSuggestions]);

  const closeSlashCommands = useCallback(() => {
    setSlashCommand({ active: false, query: "", startOffset: -1, anchorNode: null });
    setSelectedSlashIndex(0);
  }, []);

  const detectSlashCommand = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      setSlashCommand(detectSlashCommandInEditor(editor));
    }
  }, [editorRef]);

  useEffect(() => {
    if (!slashCommand.active) return;

    const item = popoverRef.current?.querySelector(`[data-slash-index="${selectedSlashIndex}"]`);
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedSlashIndex, slashCommand.active, popoverRef]);

  const selectSlashSuggestion = useCallback((entry: AvailableCommand) => {
    const editor = editorRef.current;
    if (!editor || !slashCommand.anchorNode) return;

    const textNode = slashCommand.anchorNode;
    const text = textNode.textContent ?? "";
    const beforeSlash = text.slice(0, slashCommand.startOffset);
    const afterQuery = text.slice(slashCommand.startOffset + 1 + slashCommand.query.length);

    const commandChip = createCommandChipElement({
      id: nextMentionId(),
      name: entry.name,
      description: entry.description,
    });
    const afterNode = document.createTextNode(afterQuery.length > 0 ? afterQuery : "\u00A0");
    const beforeNode = document.createTextNode(beforeSlash);
    const parent = textNode.parentNode;
    if (!parent) return;

    parent.insertBefore(beforeNode, textNode);
    parent.insertBefore(commandChip, textNode);
    parent.insertBefore(afterNode, textNode);
    parent.removeChild(textNode);

    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.setStart(afterNode, afterQuery.length > 0 ? 0 : 1);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    closeSlashCommands();
    onChange(editor.textContent?.replace(/\u00A0/g, " ") ?? "");
  }, [closeSlashCommands, editorRef, onChange, slashCommand.anchorNode, slashCommand.query, slashCommand.startOffset]);

  return {
    slashCommand,
    selectedSlashIndex,
    setSelectedSlashIndex,
    slashSuggestions,
    closeSlashCommands,
    detectSlashCommand,
    selectSlashSuggestion,
  };
}
