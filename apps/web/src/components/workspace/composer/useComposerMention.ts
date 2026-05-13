import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import fuzzysort from "fuzzysort";
import type { FileEntry } from "@codesymphony/shared-types";
import {
  detectMentionInEditor,
  getPlainTextFromEditor,
  getMentionedFilesFromEditor,
  nextMentionId,
} from "./composerEditorUtils";
import type { MentionState, MentionedFile } from "./composerEditorUtils";
import { createChipElement } from "./composerChipUtils";

type SuggestionEntry = FileEntry & { highlighted?: string };

export function useComposerMention({
  editorRef,
  popoverRef,
  fileIndex,
  fileIndexLoading,
  getEditorValue,
  onChange,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  fileIndex: FileEntry[];
  fileIndexLoading: boolean;
  getEditorValue?: (editor: HTMLDivElement) => string;
  onChange: (nextValue: string) => void;
}) {
  const [mention, setMention] = useState<MentionState>({ active: false, query: "", startOffset: -1, anchorNode: null });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mentionedFilesRef = useRef<MentionedFile[]>([]);

  const suggestions: SuggestionEntry[] = useMemo(() => {
    if (!mention.active) return [];
    const alreadyMentioned = new Set(mentionedFilesRef.current.map((f) => f.path));
    const available = fileIndex.filter((e) => !alreadyMentioned.has(e.path));

    if (!mention.query) {
      const dirs = available.filter((e) => e.type === "directory").slice(0, 5);
      const files = available.filter((e) => e.type === "file").slice(0, 20 - dirs.length);
      return [...dirs, ...files];
    }

    const results = fuzzysort.go(mention.query, available, { key: "path", limit: 20 });
    return results.map((r) => ({ ...r.obj, highlighted: r.highlight("<mark>", "</mark>") }));
  }, [mention.active, mention.query, fileIndex]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions]);

  const closeMention = useCallback(() => {
    setMention({ active: false, query: "", startOffset: -1, anchorNode: null });
    setSelectedIndex(0);
  }, []);

  const syncValueFromEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextValue = getEditorValue ? getEditorValue(editor) : getPlainTextFromEditor(editor);
    mentionedFilesRef.current = getMentionedFilesFromEditor(editor);
    onChange(nextValue);
  }, [editorRef, getEditorValue, onChange]);

  const selectSuggestion = useCallback(
    (entry: FileEntry) => {
      const editor = editorRef.current;
      if (!editor || !mention.anchorNode) return;

      const textNode = mention.anchorNode;
      const text = textNode.textContent ?? "";

      const mentionFile: MentionedFile = { ...entry, id: nextMentionId() };
      const chip = createChipElement(mentionFile);

      const beforeAt = text.slice(0, mention.startOffset);
      const afterQuery = text.slice(mention.startOffset + 1 + mention.query.length);

      const beforeNode = document.createTextNode(beforeAt);
      const afterNode = document.createTextNode(afterQuery.length > 0 ? afterQuery : "\u00A0");

      const parent = textNode.parentNode;
      if (!parent) return;

      parent.insertBefore(beforeNode, textNode);
      parent.insertBefore(chip, textNode);
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

      closeMention();
      syncValueFromEditor();
    },
    [mention.anchorNode, mention.startOffset, mention.query, closeMention, syncValueFromEditor],
  );

  const detectMention = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      const detected = detectMentionInEditor(editor);
      setMention(detected);
    }
  }, []);

  useEffect(() => {
    if (!mention.active) return;

    const item = popoverRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, mention.active]);

  return {
    mention,
    setMention,
    selectedIndex,
    setSelectedIndex,
    mentionedFilesRef,
    suggestions,
    fileIndexLoading,
    closeMention,
    syncValueFromEditor,
    selectSuggestion,
    detectMention,
  };
}
