import { type SVGProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Folder,
  Lightbulb,
  Paperclip,
  SlidersHorizontal,
  ShieldCheck,
  Square,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  type CursorModelCatalogEntry,
  DEFAULT_CHAT_MODEL_BY_AGENT,
  type ChatMode,
  type ChatThreadPermissionMode,
  type CliAgent,
  type FileEntry,
  type ModelProvider,
  type OpencodeModelCatalogEntry,
  type SlashCommand,
  type UpdateChatThreadAgentSelectionInput,
} from "@codesymphony/shared-types";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";
import type { PendingAttachment } from "../../../lib/attachments";
import {
  generateAttachmentId,
  generateClipboardFilename,
} from "../../../lib/attachments";
import { cn } from "../../../lib/utils";
import { AttachmentPreviewPanel } from "../chat-message-list/AttachmentComponents";
import { createAttachmentChipElement } from "./composerChipUtils";
import { getSerializedTextFromEditor } from "./composerEditorUtils";
import { useComposerMention } from "./useComposerMention";
import { useComposerAttachments } from "./useComposerAttachments";
import { useComposerSlashCommand } from "./useComposerSlashCommand";
import { useFileIndex } from "../../../pages/workspace/hooks/useFileIndex";

type ComposerSubmitPayload = {
  content: string;
  mode: ChatMode;
  attachments: PendingAttachment[];
};

type ComposerProps = {
  disabled: boolean;
  sending: boolean;
  showStop: boolean;
  stopping: boolean;
  threadId: string | null;
  worktreeId: string | null;
  mode: ChatMode;
  modeLocked: boolean;
  fileIndex?: FileEntry[];
  fileIndexLoading?: boolean;
  slashCommands: SlashCommand[];
  slashCommandsLoading: boolean;
  providers: ModelProvider[];
  cursorModels?: readonly CursorModelCatalogEntry[];
  opencodeModels: readonly OpencodeModelCatalogEntry[];
  agent?: CliAgent;
  model?: string;
  modelProviderId?: string | null;
  permissionMode: ChatThreadPermissionMode;
  hasMessages: boolean;
  onSubmitMessage: (payload: ComposerSubmitPayload) => Promise<boolean>;
  onModeChange: (mode: ChatMode) => void;
  onStop: () => void;
  onAgentSelectionChange?: (selection: UpdateChatThreadAgentSelectionInput) => void;
  onPermissionModeChange: (permissionMode: ChatThreadPermissionMode) => void;
};

type AgentSelectionOption = {
  id: string;
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
  label: string;
  detail: string;
  source: "builtin" | "custom";
};

type PermissionOption = {
  value: ChatThreadPermissionMode;
  label: string;
  description: string;
  icon: LucideIcon;
};

const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    value: "default",
    label: "Default",
    description: "Ask before approval-gated actions",
    icon: Clock3,
  },
  {
    value: "full_access",
    label: "Full Access",
    description: "Always allow approval-gated actions",
    icon: ShieldCheck,
  },
];

const AGENT_LABELS: Record<CliAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const MODEL_DISPLAY_NAMES_BY_AGENT: Record<CliAgent, Record<string, string>> = {
  claude: {
    "claude-sonnet-4-6": "Sonnet 4.6",
    "claude-opus-4-6": "Opus 4.6",
    "claude-haiku-4-5": "Haiku 4.5",
  },
  codex: {
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-mini": "GPT-5.4 Mini",
    "gpt-5.3-codex": "GPT-5.3 Codex",
    "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  },
  cursor: {
    "default[]": "Auto",
    "composer-2[fast=true]": "Composer 2",
    "composer-1.5[]": "Composer 1.5",
    "gpt-5.4[context=272k,reasoning=medium,fast=false]": "GPT-5.4",
    "gpt-5.4-mini[reasoning=medium]": "GPT-5.4 Mini",
    "gpt-5.3-codex[reasoning=medium,fast=false]": "GPT-5.3 Codex",
    "gpt-5.3-codex-spark[reasoning=medium]": "GPT-5.3 Codex Spark",
    "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]": "Claude Sonnet 4.6",
    "claude-opus-4-7[thinking=true,context=200k,effort=high]": "Claude Opus 4.7",
  },
  opencode: {},
};

const MODEL_TOKEN_LABELS: Record<string, string> = {
  ai: "AI",
  api: "API",
  claude: "Claude",
  codex: "Codex",
  enterprise: "Enterprise",
  glm: "GLM",
  gpt: "GPT",
  haiku: "Haiku",
  max: "Max",
  mini: "Mini",
  opus: "Opus",
  preview: "Preview",
  pro: "Pro",
  qa: "QA",
  small: "Small",
  sonnet: "Sonnet",
  spark: "Spark",
  turbo: "Turbo",
  ultra: "Ultra",
  xlarge: "XLarge",
};

function isNumericToken(token: string): boolean {
  return /^\d+(\.\d+)?$/.test(token);
}

function formatModelToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (Object.prototype.hasOwnProperty.call(MODEL_TOKEN_LABELS, normalized)) {
    return MODEL_TOKEN_LABELS[normalized]!;
  }
  if (isNumericToken(normalized)) {
    return normalized;
  }
  if (/^[a-z]+\d+[a-z\d]*$/i.test(normalized) || /^\d+[a-z]+[a-z\d]*$/i.test(normalized)) {
    return normalized.toUpperCase() === normalized
      ? normalized
      : normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  return normalized[0]!.toUpperCase() + normalized.slice(1);
}

function formatFriendlyModelName(agent: CliAgent, modelId: string): string {
  if (agent === "opencode") {
    return modelId;
  }

  const exact = MODEL_DISPLAY_NAMES_BY_AGENT[agent][modelId];
  if (exact) {
    return exact;
  }

  const normalizedModelId = modelId.replace(/\[[^\]]*]$/, "");

  const tokens = normalizedModelId
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return modelId;
  }

  const segments: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isNumericToken(token)) {
      const versionTokens = [token];
      while (index + 1 < tokens.length && isNumericToken(tokens[index + 1]!)) {
        versionTokens.push(tokens[index + 1]!);
        index += 1;
      }
      const version = versionTokens.join(".");
      if (segments.length > 0 && /^(GPT|GLM|O\d+)/.test(segments[segments.length - 1]!)) {
        segments[segments.length - 1] = `${segments[segments.length - 1]}-${version}`;
      } else {
        segments.push(version);
      }
      continue;
    }

    segments.push(formatModelToken(token));
  }

  if (agent === "claude" && segments[0] === "Claude") {
    segments.shift();
  }

  return segments.join(" ");
}

function isFirstCustomModelOption(
  options: AgentSelectionOption[],
  index: number,
): boolean {
  return options[index]?.source === "custom"
    && (index === 0 || options[index - 1]?.source !== "custom");
}

const ClaudeAiIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 257">
    <path
      fill="currentColor"
      d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
    />
  </svg>
);

const OpenAiIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 260" fill="currentColor">
    <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
  </svg>
);

const CursorCubeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 466.73 532.09">
    <path
      fill="#edecec"
      d="M457.43 125.94 244.42 2.96a22.022 22.022 0 0 0-22.12 0L9.3 125.94A18.61 18.61 0 0 0 0 142.05v247.99a18.61 18.61 0 0 0 9.3 16.11l213.01 122.98a22.022 22.022 0 0 0 22.12 0l213.01-122.98a18.61 18.61 0 0 0 9.3-16.11V142.05a18.61 18.61 0 0 0-9.3-16.11h.01Zm-13.38 26.05L238.42 508.15c-1.39 2.4-5.06 1.42-5.06-1.36V273.58c0-4.66-2.49-8.97-6.53-11.31L24.87 145.67c-2.4-1.39-1.42-5.06 1.36-5.06h411.26c5.84 0 9.49 6.33 6.57 11.39h-.01Z"
    />
  </svg>
);

const OpenCodeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
  </svg>
);

const AGENT_ICONS = {
  claude: ClaudeAiIcon,
  codex: OpenAiIcon,
  cursor: CursorCubeIcon,
  opencode: OpenCodeIcon,
} as const;

function agentIconClassName(agent: CliAgent): string {
  if (agent === "claude") {
    return "text-[#d97757]";
  }
  return "text-foreground/85";
}

function AgentIcon({
  agent,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { agent: CliAgent }) {
  const Icon = AGENT_ICONS[agent];

  return (
    <Icon
      {...props}
      data-agent-icon={agent}
      className={cn("shrink-0", agentIconClassName(agent), className)}
    />
  );
}

function AttachmentPreviewDialog({
  attachment,
  open,
  onOpenChange,
}: {
  attachment: PendingAttachment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!attachment) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-fit border-none bg-transparent p-0 shadow-none">
        <DialogTitle className="sr-only">Attachment preview</DialogTitle>
        <DialogDescription className="sr-only">{attachment.filename}</DialogDescription>
        <AttachmentPreviewPanel attachment={attachment} />
      </DialogContent>
    </Dialog>
  );
}

function ComposerContent({
  disabled,
  sending,
  showStop,
  stopping,
  threadId,
  worktreeId,
  mode,
  modeLocked,
  fileIndex,
  fileIndexLoading,
  slashCommands,
  slashCommandsLoading,
  providers,
  cursorModels = [],
  opencodeModels,
  agent: providedAgent,
  model: providedModel,
  modelProviderId: providedModelProviderId,
  permissionMode,
  hasMessages,
  onSubmitMessage,
  onModeChange,
  onStop,
  onAgentSelectionChange: onAgentSelectionChangeProp,
  onPermissionModeChange,
}: ComposerProps) {
  const [draftText, setDraftText] = useState("");
  const [attachmentPreviewId, setAttachmentPreviewId] = useState<string | null>(null);
  const agent = providedAgent ?? "claude";
  const model = providedModel ?? DEFAULT_CHAT_MODEL_BY_AGENT[agent];
  const modelProviderId = providedModelProviderId ?? null;
  const onAgentSelectionChange = onAgentSelectionChangeProp ?? (() => {});
  const isPlan = mode === "plan";
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const [modelPreviewAgent, setModelPreviewAgent] = useState<CliAgent>(agent);
  const [permissionPopoverOpen, setPermissionPopoverOpen] = useState(false);
  const permissionPopoverRef = useRef<HTMLDivElement>(null);
  const [permissionPreviewMode, setPermissionPreviewMode] = useState<ChatThreadPermissionMode | null>(null);
  const [mobileSessionSheetOpen, setMobileSessionSheetOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(max-width: 767px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 767px)");
    setIsMobile(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!modelPopoverOpen && !permissionPopoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modelPopoverRef.current && !modelPopoverRef.current.contains(e.target as Node)) {
        setModelPopoverOpen(false);
      }
      if (permissionPopoverRef.current && !permissionPopoverRef.current.contains(e.target as Node)) {
        setPermissionPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelPopoverOpen, permissionPopoverOpen]);

  useEffect(() => {
    setModelPreviewAgent(agent);
  }, [agent]);

  useEffect(() => {
    if (!isMobile) {
      setMobileSessionSheetOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!mobileSessionSheetOpen) {
      return;
    }
    setModelPopoverOpen(false);
    setPermissionPopoverOpen(false);
    setPermissionPreviewMode(null);
  }, [mobileSessionSheetOpen]);

  const selectionLocked = hasMessages || !threadId;
  const agentOptions = useMemo<Record<CliAgent, AgentSelectionOption[]>>(() => ({
    claude: [
      ...BUILTIN_CHAT_MODELS_BY_AGENT.claude.map((entry) => ({
        id: `claude:${entry}:builtin`,
        agent: "claude" as const,
        model: entry,
        modelProviderId: null,
        label: formatFriendlyModelName("claude", entry),
        detail: "Built-in",
        source: "builtin" as const,
      })),
      ...providers
        .filter((provider) => provider.agent === "claude")
        .map((provider) => ({
          id: provider.id,
          agent: "claude" as const,
          model: provider.modelId,
          modelProviderId: provider.id,
          label: formatFriendlyModelName("claude", provider.modelId),
          detail: provider.name,
          source: "custom" as const,
        })),
    ],
    codex: [
      ...BUILTIN_CHAT_MODELS_BY_AGENT.codex.map((entry) => ({
        id: `codex:${entry}:builtin`,
        agent: "codex" as const,
        model: entry,
        modelProviderId: null,
        label: formatFriendlyModelName("codex", entry),
        detail: "Built-in",
        source: "builtin" as const,
      })),
      ...providers
        .filter((provider) => provider.agent === "codex")
        .map((provider) => ({
          id: provider.id,
          agent: "codex" as const,
          model: provider.modelId,
          modelProviderId: provider.id,
          label: formatFriendlyModelName("codex", provider.modelId),
          detail: provider.name,
          source: "custom" as const,
        })),
    ],
    cursor: cursorModels.map((entry) => ({
      id: `cursor:${entry.id}:builtin`,
      agent: "cursor" as const,
      model: entry.id,
      modelProviderId: null,
      label: entry.name,
      detail: "Built-in",
      source: "builtin" as const,
    })),
    opencode: [
      ...opencodeModels.map((entry) => ({
        id: `opencode:${entry.id}:builtin`,
        agent: "opencode" as const,
        model: entry.id,
        modelProviderId: null,
        label: entry.name,
        detail: entry.providerId,
        source: "builtin" as const,
      })),
      ...providers
        .filter((provider) => provider.agent === "opencode")
        .map((provider) => ({
          id: provider.id,
          agent: "opencode" as const,
          model: provider.modelId,
          modelProviderId: provider.id,
          label: provider.modelId,
          detail: provider.name,
          source: "custom" as const,
        })),
    ],
  }), [cursorModels, opencodeModels, providers]);
  const modelPreviewOptions = agentOptions[modelPreviewAgent];
  const currentSelection = useMemo(() => {
    return agentOptions[agent].find((option) => (
      option.model === model
      && option.modelProviderId === modelProviderId
    )) ?? {
      id: modelProviderId ?? `${agent}:${model}:adhoc`,
      agent,
      model,
      modelProviderId,
      label: formatFriendlyModelName(agent, model),
      detail: modelProviderId ? "Custom" : "Built-in",
      source: modelProviderId ? "custom" as const : "builtin" as const,
    };
  }, [agent, agentOptions, model, modelProviderId]);
  const modelLabel = `${AGENT_LABELS[agent]} · ${currentSelection.label}`;
  const activePermissionOption = useMemo(
    () => PERMISSION_OPTIONS.find((option) => option.value === permissionMode) ?? PERMISSION_OPTIONS[0],
    [permissionMode],
  );
  const previewPermissionOption = useMemo(
    () => PERMISSION_OPTIONS.find((option) => option.value === permissionPreviewMode) ?? null,
    [permissionPreviewMode],
  );
  const permissionTriggerClassName = permissionMode === "full_access" ? "text-orange-500" : "text-muted-foreground";
  const mobileSessionSummaryLabel = permissionMode === "full_access" ? `${AGENT_LABELS[agent]} · Full Access` : AGENT_LABELS[agent];

  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const suppressInputRef = useRef(false);
  const prevContentLenRef = useRef(0);
  const afterChipHTMLRef = useRef<string | null>(null);
  const lastStableHTMLRef = useRef<string>("");

  const {
    mention,
    selectedIndex,
    setSelectedIndex,
    mentionedFilesRef,
    suggestions,
    closeMention,
    syncValueFromEditor,
    selectSuggestion,
    detectMention,
  } = useComposerMention({
    editorRef,
    popoverRef,
    fileIndex: fileIndex ?? [],
    fileIndexLoading: fileIndexLoading ?? false,
    onChange: setDraftText,
  });

  const {
    attachments,
    attachmentsRef,
    pendingAttachmentReads,
    pendingAttachmentReadsRef,
    applyAttachmentsChange,
    fileInputRef,
    isDragOver,
    handleFileInputChange,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeAttachment,
    handlePasteImages,
    barAttachments,
  } = useComposerAttachments({
    editorRef,
  });

  const {
    slashCommand,
    selectedIndex: selectedSlashCommandIndex,
    setSelectedIndex: setSelectedSlashCommandIndex,
    suggestions: slashCommandSuggestions,
    slashCommandsLoading: slashCommandLoading,
    closeSlashCommand,
    selectSuggestion: selectSlashCommandSuggestion,
    detectSlashCommand,
  } = useComposerSlashCommand({
    editorRef,
    popoverRef,
    slashCommands,
    slashCommandsLoading,
    onChange: setDraftText,
  });

  useEffect(() => {
    if (!mention.active && !slashCommand.active) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedInsideEditor = editorRef.current?.contains(target) ?? false;
      const clickedInsidePopover = popoverRef.current?.contains(target) ?? false;

      if (clickedInsideEditor || clickedInsidePopover) {
        return;
      }

      closeMention();
      closeSlashCommand();
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [closeMention, closeSlashCommand, mention.active, slashCommand.active]);

  const cannotSend = disabled
    || pendingAttachmentReads > 0
    || (draftText.trim().length === 0 && mentionedFilesRef.current.length === 0 && attachments.length === 0);
  const composerPlaceholder = isPlan
    ? "Describe what you want to plan..."
    : "Message CodeSymphony... (type / for commands, @ to mention files)";
  const selectedAttachmentPreview = useMemo(
    () => attachments.find((attachment) => attachment.id === attachmentPreviewId) ?? null,
    [attachmentPreviewId, attachments],
  );

  useEffect(() => {
    if (attachmentPreviewId && !selectedAttachmentPreview) {
      setAttachmentPreviewId(null);
    }
  }, [attachmentPreviewId, selectedAttachmentPreview]);

  const handleInput = useCallback(() => {
    if (suppressInputRef.current) return;

    const editor = editorRef.current;
    if (!editor) return;

    const currentText = editor.textContent ?? "";
    const prevLen = prevContentLenRef.current;
    const inserted = currentText.length - prevLen;

    const savedHTML = afterChipHTMLRef.current;
    if (savedHTML !== null && inserted > 10) {
      afterChipHTMLRef.current = null;

      editor.removeAttribute("contenteditable");
      editor.innerHTML = savedHTML;
      editor.setAttribute("contenteditable", "true");

      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      syncValueFromEditor();
      prevContentLenRef.current = (editor.textContent ?? "").length;
      lastStableHTMLRef.current = editor.innerHTML;
      return;
    }

    afterChipHTMLRef.current = null;

    if (inserted > 300) {
      const pastedText = currentText.slice(prevLen).trim() || currentText.trim();
      if (pastedText.length > 300) {
        const filename = generateClipboardFilename(pastedText);
        const att: PendingAttachment = {
          id: generateAttachmentId(),
          filename,
          mimeType: "text/plain",
          content: pastedText,
          sizeBytes: new Blob([pastedText]).size,
          source: "clipboard_text",
          isInline: true,
        };

        editor.removeAttribute("contenteditable");
        editor.innerHTML = lastStableHTMLRef.current;
        const chip = createAttachmentChipElement(att);
        const space = document.createTextNode("\u00A0");
        editor.appendChild(chip);
        editor.appendChild(space);
        editor.setAttribute("contenteditable", "true");

        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.setStartAfter(space);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }

        applyAttachmentsChange((prev) => [...prev, att]);
        syncValueFromEditor();
        prevContentLenRef.current = (editor.textContent ?? "").length;
        lastStableHTMLRef.current = editor.innerHTML;
        return;
      }
    }

    prevContentLenRef.current = (editor.textContent ?? "").length;
    lastStableHTMLRef.current = editor.innerHTML;
    syncValueFromEditor();

    queueMicrotask(() => {
      if (editor) {
        detectMention();
        detectSlashCommand();
      }
    });
  }, [syncValueFromEditor, applyAttachmentsChange, detectMention, detectSlashCommand]);

  const buildFinalContent = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) return draftText;
    return getSerializedTextFromEditor(editor).replace(/\u00A0/g, " ").trim();
  }, [draftText]);

  const resetDraft = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      editor.innerHTML = "";
    }
    mentionedFilesRef.current = [];
    closeMention();
    closeSlashCommand();
    applyAttachmentsChange([]);
    setAttachmentPreviewId(null);
    setDraftText("");
    lastStableHTMLRef.current = "";
    prevContentLenRef.current = 0;
    afterChipHTMLRef.current = null;
  }, [applyAttachmentsChange, closeMention, closeSlashCommand]);

  const handleSubmit = useCallback(async () => {
    if (cannotSend) return;
    if (pendingAttachmentReadsRef.current > 0) return;
    const content = buildFinalContent();
    const currentAttachments = attachmentsRef.current;
    if (!content.trim() && currentAttachments.length === 0) return;

    const editor = editorRef.current;
    const inlineAttachmentIds = new Set<string>();
    if (editor) {
      const chips = editor.querySelectorAll<HTMLElement>("[data-attachment-id]");
      for (const chip of chips) {
        if (chip.dataset.attachmentId) inlineAttachmentIds.add(chip.dataset.attachmentId);
      }
    }

    const allAttachments = [
      ...currentAttachments,
      ...inlineAttachmentIds.size > 0
        ? currentAttachments.filter((a) => inlineAttachmentIds.has(a.id))
        : [],
    ];

    const seen = new Set<string>();
    const dedupedAttachments = allAttachments.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    const didSubmit = await onSubmitMessage({ content, mode, attachments: dedupedAttachments });
    if (didSubmit) {
      resetDraft();
    }
  }, [cannotSend, buildFinalContent, onSubmitMessage, mode, resetDraft]);

  const handleEditorAttachmentPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-attachment-id]")
      : null;
    if (!target) {
      return;
    }

    event.preventDefault();
  }, []);

  const handleEditorAttachmentClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-attachment-id]")
      : null;
    if (!target?.dataset.attachmentId) {
      return;
    }

    event.preventDefault();
    setAttachmentPreviewId(target.dataset.attachmentId);
  }, []);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;

      if (handlePasteImages(clipboardData)) {
        event.preventDefault();
        return;
      }

      const text = clipboardData.getData("text/plain");

      if (!text) {
        return;
      }

      if (text.length > 300) {
        const editor = editorRef.current;
        const preHTML = editor?.innerHTML ?? "";

        event.preventDefault();

        const filename = generateClipboardFilename(text);
        const att: PendingAttachment = {
          id: generateAttachmentId(),
          filename,
          mimeType: "text/plain",
          content: text,
          sizeBytes: new Blob([text]).size,
          source: "clipboard_text",
          isInline: true,
        };

        applyAttachmentsChange((prev) => [...prev, att]);

        if (editor) {
          editor.removeAttribute("contenteditable");
          editor.innerHTML = preHTML;
          const chip = createAttachmentChipElement(att);
          const space = document.createTextNode("\u00A0");
          editor.appendChild(chip);
          editor.appendChild(space);
          editor.setAttribute("contenteditable", "true");

          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.setStartAfter(space);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          }

          syncValueFromEditor();
          prevContentLenRef.current = (editor.textContent ?? "").length;
          lastStableHTMLRef.current = editor.innerHTML;

          afterChipHTMLRef.current = editor.innerHTML;
        }

        return;
      }

      event.preventDefault();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      range.deleteContents();

      const lines = text.split("\n");
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          fragment.appendChild(document.createElement("br"));
        }
        if (lines[i]) {
          fragment.appendChild(document.createTextNode(lines[i]));
        }
      }

      const lastNode = fragment.lastChild;
      range.insertNode(fragment);

      if (lastNode) {
        const newRange = document.createRange();
        newRange.setStartAfter(lastNode);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }

      syncValueFromEditor();
      prevContentLenRef.current = (editorRef.current?.textContent ?? "").length;
      lastStableHTMLRef.current = editorRef.current?.innerHTML ?? "";
    },
    [syncValueFromEditor, applyAttachmentsChange, handlePasteImages],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (mention.active && suggestions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % suggestions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          selectSuggestion(suggestions[selectedIndex]);
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
          selectSlashCommandSuggestion(slashCommandSuggestions[selectedSlashCommandIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeSlashCommand();
          return;
        }
      }

      if (event.key === "Backspace") {
        const sel = window.getSelection();
        const editor = editorRef.current;
        if (sel && sel.rangeCount > 0 && editor) {
          const anchorNode = sel.anchorNode;
          const anchorOffset = sel.anchorOffset;

          if (
            anchorNode &&
            anchorNode.nodeType === Node.TEXT_NODE &&
            anchorOffset === 0 &&
            anchorNode.previousSibling instanceof HTMLElement &&
            (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.attachmentId || anchorNode.previousSibling.dataset.slashCommand)
          ) {
            event.preventDefault();
            const chip = anchorNode.previousSibling;
            const attachmentId = chip.dataset.attachmentId;
            chip.remove();
            if (attachmentId) {
              applyAttachmentsChange((prev) => prev.filter((a) => a.id !== attachmentId));
            }
            syncValueFromEditor();
            return;
          }

          if (
            anchorNode === editor &&
            anchorOffset > 0 &&
            editor.childNodes[anchorOffset - 1] instanceof HTMLElement &&
            ((editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.mentionPath ||
             (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.attachmentId ||
             (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.slashCommand)
          ) {
            event.preventDefault();
            const chip = editor.childNodes[anchorOffset - 1] as HTMLElement;
            const attachmentId = chip.dataset.attachmentId;
            chip.remove();
            if (attachmentId) {
              applyAttachmentsChange((prev) => prev.filter((a) => a.id !== attachmentId));
            }
            syncValueFromEditor();
            return;
          }

          if (
            anchorNode &&
            anchorNode.nodeType === Node.TEXT_NODE &&
            anchorOffset === 1 &&
            anchorNode.textContent === "\u00A0" &&
            anchorNode.previousSibling instanceof HTMLElement &&
            (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.attachmentId || anchorNode.previousSibling.dataset.slashCommand)
          ) {
            event.preventDefault();
            const chip = anchorNode.previousSibling;
            const attachmentId = chip.dataset.attachmentId;
            anchorNode.textContent = "";
            chip.remove();
            if (attachmentId) {
              applyAttachmentsChange((prev) => prev.filter((a) => a.id !== attachmentId));
            }
            syncValueFromEditor();
            return;
          }
        }
      }

      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        if (!modeLocked) {
          onModeChange(isPlan ? "default" : "plan");
        }
        return;
      }

      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }

      if (showStop) {
        return;
      }

      if (isMobile) {
        return;
      }

      event.preventDefault();
      handleSubmit();
    },
    [mention.active, suggestions, selectedIndex, selectSuggestion, closeMention, slashCommand.active, slashCommandSuggestions, selectedSlashCommandIndex, selectSlashCommandSuggestion, closeSlashCommand, isPlan, modeLocked, onModeChange, showStop, isMobile, handleSubmit, syncValueFromEditor, applyAttachmentsChange],
  );

  useEffect(() => {
    resetDraft();
  }, [threadId, worktreeId, resetDraft]);

  const renderModelOptions = (mobile: boolean) => (
    <>
      <div className="space-y-1" data-cli-agent-list="true">
        {(Object.keys(AGENT_LABELS) as CliAgent[]).map((entryAgent) => {
          const selectedAgent = modelPreviewAgent === entryAgent;
          const currentAgent = agent === entryAgent;

          return (
            <button
              key={entryAgent}
              type="button"
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                selectedAgent
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50"
              }`}
              aria-current={currentAgent ? "true" : undefined}
              onMouseEnter={() => {
                if (!mobile) {
                  setModelPreviewAgent(entryAgent);
                }
              }}
              onFocus={() => setModelPreviewAgent(entryAgent)}
              onMouseDown={(e) => {
                e.preventDefault();
                setModelPreviewAgent(entryAgent);
              }}
            >
              <AgentIcon agent={entryAgent} aria-hidden="true" className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{AGENT_LABELS[entryAgent]}</span>
              {currentAgent ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </button>
          );
        })}
      </div>

      {mobile ? (
        <div
          data-agent-model-panel="stacked"
          className="mt-1 border-t border-border/60 pt-1"
        >
          <div className="max-h-[min(18rem,calc(100vh-10rem))] overflow-y-auto pt-1">
            {modelPreviewOptions.map((option, index) => {
              const selected = option.agent === agent
                && option.model === model
                && option.modelProviderId === modelProviderId;
              const showCustomSeparator = isFirstCustomModelOption(modelPreviewOptions, index);

              return (
                <div key={option.id}>
                  {showCustomSeparator ? (
                    <div
                      data-model-separator="custom"
                      className="mx-2.5 my-1 border-t border-border/60"
                    />
                  ) : null}
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onAgentSelectionChange({
                        agent: option.agent,
                        model: option.model,
                        modelProviderId: option.modelProviderId,
                      });
                      setModelPopoverOpen(false);
                      setMobileSessionSheetOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                    {option.source === "custom" ? (
                      <span className="max-w-[7rem] truncate text-[10px] text-muted-foreground">
                        {option.detail}
                      </span>
                    ) : null}
                    {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );

  const renderPermissionOptions = (mobile: boolean) => (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-popover p-1 shadow-lg",
        mobile ? "w-full" : "w-[220px]",
      )}
      onMouseLeave={() => setPermissionPreviewMode(null)}
    >
      <div className="max-h-48 overflow-y-auto">
        {PERMISSION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              permissionMode === option.value
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/50"
            }`}
            aria-label={`${option.label}. ${option.description}`}
            aria-current={permissionMode === option.value ? "true" : undefined}
            onMouseEnter={() => setPermissionPreviewMode(option.value)}
            onFocus={() => setPermissionPreviewMode(option.value)}
            onBlur={() => setPermissionPreviewMode((current) => (current === option.value ? null : current))}
            onMouseDown={(e) => {
              e.preventDefault();
              onPermissionModeChange(option.value);
              setPermissionPreviewMode(null);
              setPermissionPopoverOpen(false);
              if (mobile) {
                setMobileSessionSheetOpen(false);
              }
            }}
          >
            <option.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{option.label}</span>
              {mobile ? (
                <span className="mt-0.5 block whitespace-normal text-[10px] leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
            {permissionMode === option.value ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="pb-1 pt-0.5 safe-bottom lg:pb-2 lg:pt-1">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={`relative rounded-2xl border bg-background/20 px-3 pb-11 pt-2.5 lg:rounded-3xl lg:px-4 lg:pb-12 lg:pt-3 transition-colors ${
            isDragOver ? "border-primary/60 bg-primary/5" : "border-input/50"
          }`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 lg:rounded-3xl">
              <span className="text-sm font-medium text-primary">Drop files here</span>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="text/*,image/*,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.md,.json,.yaml,.yml,.toml,.sql,.sh,.css,.scss,.html,.xml,.svg"
            className="hidden"
            onChange={handleFileInputChange}
          />

          {mention.active && (suggestions.length > 0 || (fileIndexLoading ?? false)) && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 z-50 mb-2 w-full max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg"
            >
              {(fileIndexLoading ?? false) && suggestions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading files...</div>
              ) : (
                suggestions.map((entry, index) => (
                  <button
                    key={entry.path}
                    type="button"
                    data-index={index}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      index === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(entry);
                    }}
                    onMouseEnter={() => setSelectedIndex(index)}
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
          )}

          {slashCommand.active && (slashCommandSuggestions.length > 0 || slashCommandLoading) && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 z-50 mb-2 w-full max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg"
            >
              {slashCommandLoading && slashCommandSuggestions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading commands...</div>
              ) : (
                slashCommandSuggestions.map((entry, index) => (
                  <button
                    key={entry.name}
                    type="button"
                    data-index={index}
                    className={`flex w-full items-start px-3 py-2 text-left text-sm transition-colors ${
                      index === selectedSlashCommandIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSlashCommandSuggestion(entry);
                    }}
                    onMouseEnter={() => setSelectedSlashCommandIndex(index)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {entry.highlighted ? (
                          <span className="font-medium" dangerouslySetInnerHTML={{ __html: entry.highlighted }} />
                        ) : (
                          <span className="font-medium">/{entry.name}</span>
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
          )}

          {barAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {barAttachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/40 px-2 py-1 text-xs text-foreground"
                >
                  {att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.filename}
                      className="h-6 w-6 rounded object-cover"
                    />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="max-w-[120px] truncate">{att.filename}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="ml-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
                    aria-label={`Remove ${att.filename}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            ref={editorRef}
            role="textbox"
            aria-multiline="true"
            aria-placeholder={composerPlaceholder}
            contentEditable={!disabled}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onPointerDownCapture={handleEditorAttachmentPointerDown}
            onClick={handleEditorAttachmentClick}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              handleInput();
            }}
            data-placeholder={composerPlaceholder}
            className={`min-h-[60px] max-h-[140px] w-full overflow-y-auto resize-none border-none bg-transparent p-0 text-sm text-foreground shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none md:min-h-[74px] md:max-h-[400px] ${
              disabled ? "cursor-not-allowed opacity-50" : ""
            }`}
          />

          <div className="absolute bottom-2 left-2.5 right-12 flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:bottom-3 lg:left-3 lg:right-auto lg:overflow-visible">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="flex items-center justify-center rounded-full bg-secondary/60 p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground disabled:opacity-50"
              aria-label="Attach files"
            >
              <Paperclip className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!modeLocked) {
                  onModeChange(isPlan ? "default" : "plan");
                }
              }}
              disabled={modeLocked}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                isPlan
                  ? "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              aria-label={isPlan ? "Switch to execute mode" : "Switch to plan mode"}
            >
              {isPlan ? <Lightbulb className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              {isPlan ? "Plan" : "Execute"}
            </button>
            {isMobile ? (
              <Dialog open={mobileSessionSheetOpen} onOpenChange={setMobileSessionSheetOpen}>
                <button
                  type="button"
                  onClick={() => {
                    if (selectionLocked || disabled) {
                      return;
                    }
                    setModelPreviewAgent(agent);
                    setMobileSessionSheetOpen(true);
                  }}
                  disabled={selectionLocked || disabled}
                  title={selectionLocked ? "CLI agent is locked for this thread. Start a new thread to change it." : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium transition-colors",
                    selectionLocked || disabled
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-secondary/70 hover:text-foreground",
                    permissionMode === "full_access" ? "text-orange-500" : "text-muted-foreground",
                  )}
                  aria-label="Open session settings"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
                  <AgentIcon agent={agent} aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="max-w-[96px] truncate">{mobileSessionSummaryLabel}</span>
                  {permissionMode === "full_access" ? <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> : null}
                </button>
                <DialogContent className="bottom-0 left-0 top-auto grid w-full max-w-none translate-x-0 translate-y-0 gap-3 rounded-b-none rounded-t-3xl border-border/70 bg-card/98 px-4 pb-4 pt-5 shadow-2xl md:bottom-auto md:left-[50%] md:top-[50%] md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl">
                  <DialogTitle className="text-base">Session settings</DialogTitle>
                  <DialogDescription className="text-xs">
                    Choose agent, model, and permission mode for this thread.
                  </DialogDescription>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Agent and model
                      </div>
                      <div className="rounded-2xl border border-border/60 bg-background/40 p-1">
                        {renderModelOptions(true)}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Permission mode
                      </div>
                      {renderPermissionOptions(true)}
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            ) : (
              <>
                <div className="relative" ref={modelPopoverRef}>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectionLocked) {
                        return;
                      }
                      if (!modelPopoverOpen) {
                        setModelPreviewAgent(agent);
                      }
                      setModelPopoverOpen(!modelPopoverOpen);
                    }}
                    disabled={selectionLocked}
                    title={selectionLocked
                      ? "CLI agent is locked for this thread. Start a new thread to change it."
                      : currentSelection.model}
                    className={`flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors ${
                      selectionLocked
                        ? "cursor-not-allowed opacity-50"
                        : "hover:bg-secondary/70 hover:text-foreground"
                    }`}
                    aria-label="Select CLI agent and model"
                  >
                    <AgentIcon agent={agent} aria-hidden="true" className="h-3.5 w-3.5" />
                    <span className="max-w-[160px] truncate">{modelLabel}</span>
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  </button>

                  {modelPopoverOpen && (
                    <div className="absolute bottom-full left-0 z-50 mb-1.5 w-[210px]">
                      <div className="relative">
                        <div className="rounded-xl border border-border/60 bg-popover p-1 shadow-lg">
                          {renderModelOptions(false)}
                        </div>

                        <div
                          data-agent-model-panel="overlay"
                          className="absolute bottom-0 left-full z-10 ml-2 w-[250px] rounded-xl border border-border/60 bg-popover p-1 shadow-lg"
                        >
                          <div className="max-h-[min(18rem,calc(100vh-10rem))] overflow-y-auto">
                            {modelPreviewOptions.map((option, index) => {
                              const selected = option.agent === agent
                                && option.model === model
                                && option.modelProviderId === modelProviderId;
                              const showCustomSeparator = isFirstCustomModelOption(modelPreviewOptions, index);

                              return (
                                <div key={option.id}>
                                  {showCustomSeparator ? (
                                    <div
                                      data-model-separator="custom"
                                      className="mx-2.5 my-1 border-t border-border/60"
                                    />
                                  ) : null}
                                  <button
                                    type="button"
                                    title={option.model}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                                      selected
                                        ? "bg-accent text-accent-foreground"
                                        : "text-foreground hover:bg-accent/50"
                                    }`}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      onAgentSelectionChange({
                                        agent: option.agent,
                                        model: option.model,
                                        modelProviderId: option.modelProviderId,
                                      });
                                      setModelPopoverOpen(false);
                                    }}
                                  >
                                    <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                                    <span className="max-w-[7rem] truncate text-[10px] text-muted-foreground">
                                      {option.detail}
                                    </span>
                                    {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="relative" ref={permissionPopoverRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setPermissionPopoverOpen((open) => {
                        const nextOpen = !open;
                        if (!nextOpen) {
                          setPermissionPreviewMode(null);
                        }
                        return nextOpen;
                      });
                    }}
                    disabled={disabled}
                    className={`flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary/70 disabled:cursor-not-allowed disabled:opacity-50 ${permissionTriggerClassName} ${
                      permissionMode === "full_access" ? "hover:text-orange-400" : "hover:text-foreground"
                    }`}
                    aria-label="Select permission mode"
                  >
                    <activePermissionOption.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-[160px] truncate">{activePermissionOption.label}</span>
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  </button>

                  {permissionPopoverOpen && (
                    <div className="absolute bottom-full left-0 z-50 mb-1.5">
                      <div className="relative">
                        {renderPermissionOptions(false)}
                        {previewPermissionOption ? (
                          <div className="absolute left-full top-0 ml-2 w-[220px] rounded-lg border border-border/60 bg-popover/95 p-3 shadow-lg">
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
                              {previewPermissionOption.description}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="absolute bottom-2 right-2.5 flex items-center gap-2 lg:bottom-3 lg:right-3">
            <Button
              type="button"
              onClick={showStop ? onStop : handleSubmit}
              disabled={showStop ? stopping : cannotSend}
              size="icon"
              aria-label={showStop ? "Stop run" : "Send message"}
              className="h-8 w-8 rounded-full bg-white text-black hover:bg-white/90 disabled:bg-white/80 disabled:text-black/70"
            >
              {showStop ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <ArrowUp className="h-3.5 w-3.5" />}
              <span className="sr-only">
                {showStop ? (stopping ? "Stopping..." : "Stop run") : sending ? "Running..." : "Send message"}
              </span>
            </Button>
          </div>
        </div>
      </div>
      <AttachmentPreviewDialog
        attachment={selectedAttachmentPreview}
        open={selectedAttachmentPreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAttachmentPreviewId(null);
          }
        }}
      />
    </section>
  );
}

function ComposerFileIndexBridge(props: ComposerProps) {
  const fileIndex = useFileIndex(props.worktreeId);

  return (
    <ComposerContent
      {...props}
      fileIndex={fileIndex.entries}
      fileIndexLoading={fileIndex.loading}
    />
  );
}

export function Composer(props: ComposerProps) {
  if (props.fileIndex !== undefined && typeof props.fileIndexLoading === "boolean") {
    return <ComposerContent {...props} />;
  }

  return <ComposerFileIndexBridge {...props} />;
}
