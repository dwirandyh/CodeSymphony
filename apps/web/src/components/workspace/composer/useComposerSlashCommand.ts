import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import fuzzysort from "fuzzysort";
import type { SlashCommand } from "@codesymphony/shared-types";
import { detectSlashCommandInEditor } from "./composerEditorUtils";
import { createSlashCommandChipElement } from "./composerChipUtils";

type SlashCommandSuggestion = SlashCommand & { highlighted?: string; shortDescription?: string };
type SlashCommandState = ReturnType<typeof detectSlashCommandInEditor>;

function toShortDescription(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  const trimmedAtTrigger = compact.split(/\bTRIGGER\b/i)[0]?.trim() ?? compact;
  const trimmedAtDoNotTrigger = trimmedAtTrigger.split(/\bDO NOT TRIGGER\b/i)[0]?.trim() ?? trimmedAtTrigger;
  const firstSentence = trimmedAtDoNotTrigger.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? trimmedAtDoNotTrigger;
  const short = firstSentence.length > 96 ? `${firstSentence.slice(0, 95).trimEnd()}…` : firstSentence;
  return short;
}

export function useComposerSlashCommand({
  editorRef,
  popoverRef,
  slashCommands,
  slashCommandsLoading,
  getEditorValue,
  onChange,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  slashCommands: SlashCommand[];
  slashCommandsLoading: boolean;
  getEditorValue?: (editor: HTMLDivElement) => string;
  onChange: (nextValue: string) => void;
}) {
  const [slashCommand, setSlashCommand] = useState<SlashCommandState>({
    active: false,
    query: "",
    startOffset: -1,
    anchorNode: null as Node | null,
    trigger: "/",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const lastSyncedValueRef = useRef<string | null>(null);

  const suggestions: SlashCommandSuggestion[] = useMemo(() => {
    if (!slashCommand.active) return [];
    if (!slashCommand.query) {
      return slashCommands.slice(0, 20).map((command) => ({
        ...command,
        shortDescription: toShortDescription(command.description),
      }));
    }
    const results = fuzzysort.go(slashCommand.query, slashCommands, { key: "name", limit: 20 });
    return results.map((result) => ({
      ...result.obj,
      highlighted: result.highlight("<mark>", "</mark>"),
      shortDescription: toShortDescription(result.obj.description),
    }));
  }, [slashCommand.active, slashCommand.query, slashCommands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions]);

  const closeSlashCommand = useCallback(() => {
    setSlashCommand({ active: false, query: "", startOffset: -1, anchorNode: null, trigger: "/" });
    setSelectedIndex(0);
  }, []);

  const syncValueFromEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextValue = getEditorValue ? getEditorValue(editor) : (editor.textContent ?? "");
    if (lastSyncedValueRef.current === nextValue) {
      return;
    }
    lastSyncedValueRef.current = nextValue;
    onChange(nextValue);
  }, [editorRef, getEditorValue, onChange]);

  const selectSuggestion = useCallback((entry: SlashCommand) => {
    const editor = editorRef.current;
    if (!editor || !slashCommand.anchorNode || slashCommand.anchorNode.nodeType !== Node.TEXT_NODE) {
      return;
    }

    const textNode = slashCommand.anchorNode as Text;
    const text = textNode.textContent ?? "";
    const beforeSlash = text.slice(0, slashCommand.startOffset);
    const afterQuery = text.slice(slashCommand.startOffset + 1 + slashCommand.query.length);

    const chip = createSlashCommandChipElement(entry.name, slashCommand.trigger);

    const beforeNode = document.createTextNode(beforeSlash);
    const afterNode = document.createTextNode(afterQuery.length > 0 ? afterQuery : "\u00A0");

    const parent = textNode.parentNode;
    if (!parent) {
      return;
    }

    parent.insertBefore(beforeNode, textNode);
    parent.insertBefore(chip, textNode);
    parent.insertBefore(afterNode, textNode);
    parent.removeChild(textNode);

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.setStart(afterNode, afterQuery.length > 0 ? 0 : 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    closeSlashCommand();
    const nextValue = getEditorValue ? getEditorValue(editor) : (editor.textContent ?? `${slashCommand.trigger}${entry.name}`);
    lastSyncedValueRef.current = nextValue;
    onChange(nextValue);
  }, [closeSlashCommand, editorRef, getEditorValue, onChange, slashCommand.anchorNode, slashCommand.query, slashCommand.startOffset, slashCommand.trigger]);

  const detectSlashCommand = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      setSlashCommand(detectSlashCommandInEditor(editor));
    }
  }, [editorRef]);

  useEffect(() => {
    if (!slashCommand.active) return;
    const item = popoverRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [popoverRef, selectedIndex, slashCommand.active]);

  return {
    slashCommand,
    selectedIndex,
    setSelectedIndex,
    suggestions,
    slashCommandsLoading,
    closeSlashCommand,
    syncValueFromEditor,
    selectSuggestion,
    detectSlashCommand,
  };
}
