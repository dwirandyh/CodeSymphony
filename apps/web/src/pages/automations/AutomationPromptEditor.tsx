import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import fuzzysort from "fuzzysort";
import { FileText, Folder } from "lucide-react";
import type { CliAgent, FileEntry, SlashCommand } from "@codesymphony/shared-types";
import { serializeMention } from "../../lib/mentions";
import { cn } from "../../lib/utils";
import { useFileIndex } from "../workspace/hooks/useFileIndex";
import { useSlashCommands } from "../workspace/hooks/useSlashCommands";

type MentionTriggerState = {
  active: boolean;
  start: number;
  end: number;
  query: string;
};

type SlashTriggerState = {
  active: boolean;
  start: number;
  end: number;
  query: string;
  trigger: "/" | "$";
};

type SuggestionEntry = FileEntry & { highlighted?: string };
type SlashCommandSuggestion = SlashCommand & { highlighted?: string; shortDescription?: string };

function inactiveMentionTrigger(): MentionTriggerState {
  return { active: false, start: -1, end: -1, query: "" };
}

function inactiveSlashTrigger(): SlashTriggerState {
  return { active: false, start: -1, end: -1, query: "", trigger: "/" };
}

function normalizeValue(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function detectMentionTrigger(value: string, cursor: number): MentionTriggerState {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
  if (!match) {
    return inactiveMentionTrigger();
  }

  const query = match[2] ?? "";
  if (query.includes(":")) {
    return inactiveMentionTrigger();
  }

  return {
    active: true,
    start: cursor - query.length - 1,
    end: cursor,
    query,
  };
}

function detectSlashTrigger(value: string, cursor: number): SlashTriggerState {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)([/$])([a-zA-Z0-9-]*)$/);
  if (!match) {
    return inactiveSlashTrigger();
  }

  const trigger = match[2] === "$" ? "$" : "/";
  const query = match[3] ?? "";

  return {
    active: true,
    start: cursor - query.length - 1,
    end: cursor,
    query,
    trigger,
  };
}

function toShortDescription(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  const trimmedAtTrigger = compact.split(/\bTRIGGER\b/i)[0]?.trim() ?? compact;
  const trimmedAtDoNotTrigger = trimmedAtTrigger.split(/\bDO NOT TRIGGER\b/i)[0]?.trim() ?? trimmedAtTrigger;
  const firstSentence = trimmedAtDoNotTrigger.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? trimmedAtDoNotTrigger;
  return firstSentence.length > 96
    ? `${firstSentence.slice(0, 95).trimEnd()}…`
    : firstSentence;
}

function getInsertionSuffix(after: string): string {
  if (after.length === 0) {
    return " ";
  }

  return /^[\s.,!?;:)]/.test(after) ? "" : " ";
}

type AutomationPromptEditorProps = {
  value: string;
  onChange: (value: string) => void;
  worktreeId: string | null;
  agent: CliAgent;
  placeholder: string;
  className?: string;
  disabled?: boolean;
  testId?: string;
};

export function AutomationPromptEditor({
  value,
  onChange,
  worktreeId,
  agent,
  placeholder,
  className,
  disabled = false,
  testId,
}: AutomationPromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<MentionTriggerState>(inactiveMentionTrigger);
  const [slashCommand, setSlashCommand] = useState<SlashTriggerState>(inactiveSlashTrigger);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const fileIndexState = useFileIndex(worktreeId);
  const slashCommandsState = useSlashCommands(worktreeId, agent);

  const syncTriggers = useCallback((nextValue: string, cursor: number) => {
    setMention(detectMentionTrigger(nextValue, cursor));
    setSlashCommand(detectSlashTrigger(nextValue, cursor));
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    if (normalizeValue(textarea.value) !== value) {
      textarea.value = value;
    }

    const cursor = textarea.selectionStart ?? value.length;
    syncTriggers(value, cursor);
  }, [syncTriggers, value]);

  const mentionSuggestions = useMemo<SuggestionEntry[]>(() => {
    if (!mention.active) {
      return [];
    }

    if (!mention.query) {
      const directories = fileIndexState.entries.filter((entry) => entry.type === "directory").slice(0, 5);
      const files = fileIndexState.entries.filter((entry) => entry.type === "file").slice(0, 15);
      return [...directories, ...files].slice(0, 20);
    }

    const results = fuzzysort.go(mention.query, fileIndexState.entries, { key: "path", limit: 20 });
    return results.map((result) => ({
      ...result.obj,
      highlighted: result.highlight("<mark>", "</mark>"),
    }));
  }, [fileIndexState.entries, mention.active, mention.query]);

  const slashCommandSuggestions = useMemo<SlashCommandSuggestion[]>(() => {
    if (!slashCommand.active) {
      return [];
    }

    if (!slashCommand.query) {
      return slashCommandsState.commands.slice(0, 20).map((command) => ({
        ...command,
        shortDescription: toShortDescription(command.description),
      }));
    }

    const results = fuzzysort.go(slashCommand.query, slashCommandsState.commands, { key: "name", limit: 20 });
    return results.map((result) => ({
      ...result.obj,
      highlighted: result.highlight("<mark>", "</mark>"),
      shortDescription: toShortDescription(result.obj.description),
    }));
  }, [slashCommand.active, slashCommand.query, slashCommandsState.commands]);

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [mentionSuggestions]);

  useEffect(() => {
    setSelectedSlashCommandIndex(0);
  }, [slashCommandSuggestions]);

  const closeMention = useCallback(() => {
    setMention(inactiveMentionTrigger());
    setSelectedMentionIndex(0);
  }, []);

  const closeSlashCommand = useCallback(() => {
    setSlashCommand(inactiveSlashTrigger());
    setSelectedSlashCommandIndex(0);
  }, []);

  const applyReplacement = useCallback((start: number, end: number, replacement: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const after = value.slice(end);
    const suffix = getInsertionSuffix(after);
    const nextValue = `${value.slice(0, start)}${replacement}${suffix}${after}`;
    const nextCursor = start + replacement.length + suffix.length;

    onChange(nextValue);
    closeMention();
    closeSlashCommand();

    requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current;
      if (!nextTextarea) {
        return;
      }

      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextCursor, nextCursor);
      syncTriggers(nextValue, nextCursor);
    });
  }, [closeMention, closeSlashCommand, onChange, syncTriggers, value]);

  const selectMention = useCallback((entry: FileEntry) => {
    applyReplacement(mention.start, mention.end, serializeMention(entry.path, entry.type));
  }, [applyReplacement, mention.end, mention.start]);

  const selectSlashCommand = useCallback((entry: SlashCommand) => {
    applyReplacement(slashCommand.start, slashCommand.end, `${slashCommand.trigger}${entry.name}`);
  }, [applyReplacement, slashCommand.end, slashCommand.start, slashCommand.trigger]);

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = normalizeValue(event.target.value);
    onChange(nextValue);
    syncTriggers(nextValue, event.target.selectionStart ?? nextValue.length);
  }, [onChange, syncTriggers]);

  const handleSelectionChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    syncTriggers(textarea.value, textarea.selectionStart ?? textarea.value.length);
  }, [syncTriggers]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.active && mentionSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedMentionIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedMentionIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectMention(mentionSuggestions[selectedMentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
    }

    if (slashCommand.active && slashCommandSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSlashCommandIndex((prev) => (prev + 1) % slashCommandSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSlashCommandIndex((prev) => (prev - 1 + slashCommandSuggestions.length) % slashCommandSuggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashCommand(slashCommandSuggestions[selectedSlashCommandIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashCommand();
      }
    }
  }, [
    closeMention,
    closeSlashCommand,
    mention.active,
    mentionSuggestions,
    selectedMentionIndex,
    selectedSlashCommandIndex,
    selectMention,
    selectSlashCommand,
    slashCommand.active,
    slashCommandSuggestions,
  ]);

  const activeSuggestionMode = mention.active && mention.start >= slashCommand.start
    ? "mention"
    : slashCommand.active
      ? "slash"
      : null;

  const showMentionPopover = activeSuggestionMode === "mention" && (mentionSuggestions.length > 0 || fileIndexState.loading);
  const showSlashPopover = activeSuggestionMode === "slash" && (slashCommandSuggestions.length > 0 || slashCommandsState.loading);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onClick={handleSelectionChange}
        onKeyUp={handleSelectionChange}
        onSelect={handleSelectionChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        disabled={disabled}
        spellCheck={false}
        className={cn(
          "min-h-[112px] w-full resize-y overflow-y-auto rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:ring-offset-0",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      />

      {showMentionPopover ? (
        <div className="absolute left-0 right-0 z-[70] mt-2 max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg">
          {fileIndexState.loading && mentionSuggestions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading files...</div>
          ) : (
            mentionSuggestions.map((entry, index) => (
              <button
                key={entry.path}
                type="button"
                data-index={index}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                  index === selectedMentionIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectMention(entry);
                }}
                onMouseEnter={() => setSelectedMentionIndex(index)}
              >
                {entry.type === "directory" ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                {entry.highlighted ? (
                  <span className="truncate" dir="rtl" style={{ textAlign: "left" }} dangerouslySetInnerHTML={{ __html: entry.highlighted }} />
                ) : (
                  <span className="truncate" dir="rtl" style={{ textAlign: "left" }}>{entry.path}</span>
                )}
              </button>
            ))
          )}
        </div>
      ) : null}

      {showSlashPopover ? (
        <div className="absolute left-0 right-0 z-[70] mt-2 max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg">
          {slashCommandsState.loading && slashCommandSuggestions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading commands...</div>
          ) : (
            slashCommandSuggestions.map((entry, index) => (
              <button
                key={entry.name}
                type="button"
                data-index={index}
                className={cn(
                  "flex w-full items-start px-3 py-2 text-left text-sm transition-colors",
                  index === selectedSlashCommandIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectSlashCommand(entry);
                }}
                onMouseEnter={() => setSelectedSlashCommandIndex(index)}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {entry.highlighted ? (
                      <span className="font-medium">
                        {slashCommand.trigger}
                        <span dangerouslySetInnerHTML={{ __html: entry.highlighted }} />
                      </span>
                    ) : (
                      <span className="font-medium">{slashCommand.trigger}{entry.name}</span>
                    )}
                    {entry.argumentHint ? (
                      <span className="truncate text-xs text-muted-foreground">{entry.argumentHint}</span>
                    ) : null}
                  </span>
                  {entry.shortDescription ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{entry.shortDescription}</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
