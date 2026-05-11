import { type SVGProps, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  type CliAgent,
  type CodexModelCatalogEntry,
  type CursorModelCatalogEntry,
  type ModelProvider,
  type OpencodeModelCatalogEntry,
} from "@codesymphony/shared-types";
import { FALLBACK_CODEX_MODELS } from "../../../lib/agentModelDefaults";
import { cn } from "../../../lib/utils";

export type AgentModelSelection = {
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
};

export type AgentSelectionOption = AgentModelSelection & {
  id: string;
  label: string;
  detail: string;
  source: "builtin" | "custom";
};

type AgentModelSelectorProps = {
  disabled?: boolean;
  selection: AgentModelSelection;
  providers: ModelProvider[];
  codexModels?: readonly CodexModelCatalogEntry[];
  cursorModels?: readonly CursorModelCatalogEntry[];
  opencodeModels: readonly OpencodeModelCatalogEntry[];
  codexBuiltinModelOverride?: string | null;
  showAgentList: boolean;
  selectionLockedReason?: string | null;
  ariaLabel?: string;
  className?: string;
  triggerVariant?: "pill" | "picker";
  triggerClassName?: string;
  onSelectionChange: (selection: AgentModelSelection) => void;
};

export const CLI_AGENTS: CliAgent[] = ["claude", "codex", "cursor", "opencode"];

export const AGENT_LABELS: Record<CliAgent, string> = {
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

export function formatFriendlyModelName(agent: CliAgent, modelId: string): string {
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

type CodexBuiltinOptionSeed = {
  id: string;
  name: string;
};

function buildCodexBuiltinOptionSeeds(params: {
  codexModels: readonly CodexModelCatalogEntry[];
  codexBuiltinModelOverride?: string | null;
}): Array<CodexBuiltinOptionSeed & { detail: string }> {
  const normalizedCodexBuiltinModelOverride = typeof params.codexBuiltinModelOverride === "string"
    ? params.codexBuiltinModelOverride.trim()
    : "";
  const catalogEntries = params.codexModels.length > 0
    ? params.codexModels.map((entry) => ({
      id: entry.id,
      name: entry.name.trim() || formatFriendlyModelName("codex", entry.id),
    }))
    : FALLBACK_CODEX_MODELS.map((entry) => ({
      id: entry.id,
      name: entry.name.trim() || formatFriendlyModelName("codex", entry.id),
    }));
  const deduped = new Map<string, CodexBuiltinOptionSeed>();

  if (normalizedCodexBuiltinModelOverride.length > 0) {
    const overrideInCatalog = catalogEntries.some((entry) => entry.id === normalizedCodexBuiltinModelOverride);
    if (!overrideInCatalog) {
      deduped.set(normalizedCodexBuiltinModelOverride, {
        id: normalizedCodexBuiltinModelOverride,
        name: formatFriendlyModelName("codex", normalizedCodexBuiltinModelOverride),
      });
    }
  }

  for (const entry of catalogEntries) {
    if (!deduped.has(entry.id)) {
      deduped.set(entry.id, entry);
    }
  }

  return Array.from(deduped.values()).map((entry) => ({
    ...entry,
    detail: normalizedCodexBuiltinModelOverride.length > 0 && entry.id === normalizedCodexBuiltinModelOverride
      ? "Codex CLI default"
      : "Built-in",
  }));
}

export function buildAgentSelectionOptions(params: {
  providers: ModelProvider[];
  codexModels?: readonly CodexModelCatalogEntry[];
  cursorModels?: readonly CursorModelCatalogEntry[];
  opencodeModels: readonly OpencodeModelCatalogEntry[];
  codexBuiltinModelOverride?: string | null;
}): Record<CliAgent, AgentSelectionOption[]> {
  const cursorModels = params.cursorModels ?? [];
  const codexBuiltinModels = buildCodexBuiltinOptionSeeds({
    codexModels: params.codexModels ?? [],
    codexBuiltinModelOverride: params.codexBuiltinModelOverride,
  });

  return {
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
      ...params.providers
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
      ...codexBuiltinModels.map((entry) => ({
        id: `codex:${entry.id}:builtin`,
        agent: "codex" as const,
        model: entry.id,
        modelProviderId: null,
        label: entry.name.trim() || formatFriendlyModelName("codex", entry.id),
        detail: entry.detail,
        source: "builtin" as const,
      })),
      ...params.providers
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
      ...params.opencodeModels.map((entry) => ({
        id: `opencode:${entry.id}:builtin`,
        agent: "opencode" as const,
        model: entry.id,
        modelProviderId: null,
        label: entry.name,
        detail: entry.providerId,
        source: "builtin" as const,
      })),
      ...params.providers
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
  };
}

export function flattenAgentSelectionOptions(agentOptions: Record<CliAgent, AgentSelectionOption[]>): AgentSelectionOption[] {
  return CLI_AGENTS.flatMap((agent) => agentOptions[agent]);
}

export function findAgentSelectionOption(
  agentOptions: Record<CliAgent, AgentSelectionOption[]>,
  selection: AgentModelSelection,
): AgentSelectionOption | null {
  return agentOptions[selection.agent].find((option) => (
    option.model === selection.model
    && option.modelProviderId === selection.modelProviderId
  )) ?? null;
}

export function getCurrentAgentSelectionOption(
  agentOptions: Record<CliAgent, AgentSelectionOption[]>,
  selection: AgentModelSelection,
): AgentSelectionOption {
  return findAgentSelectionOption(agentOptions, selection) ?? {
    id: selection.modelProviderId ?? `${selection.agent}:${selection.model}:adhoc`,
    agent: selection.agent,
    model: selection.model,
    modelProviderId: selection.modelProviderId,
    label: formatFriendlyModelName(selection.agent, selection.model),
    detail: selection.modelProviderId ? "Custom" : "Built-in",
    source: selection.modelProviderId ? "custom" : "builtin",
  };
}

export function isFirstCustomModelOption(
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

export function AgentIcon({
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

export function AgentModelSelector({
  disabled = false,
  selection,
  providers,
  codexModels = [],
  cursorModels = [],
  opencodeModels,
  codexBuiltinModelOverride = null,
  showAgentList,
  selectionLockedReason = null,
  ariaLabel,
  className,
  triggerVariant = "pill",
  triggerClassName: customTriggerClassName,
  onSelectionChange,
}: AgentModelSelectorProps) {
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [modelPreviewAgent, setModelPreviewAgent] = useState<CliAgent>(selection.agent);
  const modelPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelPopoverOpen) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (modelPopoverRef.current && !modelPopoverRef.current.contains(event.target as Node)) {
        setModelPopoverOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelPopoverOpen]);

  useEffect(() => {
    setModelPreviewAgent(selection.agent);
  }, [selection.agent]);

  const agentOptions = useMemo(() => buildAgentSelectionOptions({
    providers,
    codexModels,
    cursorModels,
    opencodeModels,
    codexBuiltinModelOverride,
  }), [codexBuiltinModelOverride, codexModels, cursorModels, opencodeModels, providers]);
  const currentSelection = useMemo(
    () => getCurrentAgentSelectionOption(agentOptions, selection),
    [agentOptions, selection],
  );
  const modelPreviewTargetAgent = showAgentList ? modelPreviewAgent : selection.agent;
  const modelPreviewOptions = useMemo(() => {
    const options = agentOptions[modelPreviewTargetAgent];
    if (showAgentList) {
      return options;
    }

    return options.filter((option) => option.modelProviderId === selection.modelProviderId);
  }, [agentOptions, modelPreviewTargetAgent, selection.modelProviderId, showAgentList]);
  const modelLabel = `${AGENT_LABELS[selection.agent]} · ${currentSelection.label}`;
  const resolvedAriaLabel = ariaLabel ?? (
    showAgentList
      ? "Select CLI agent and model"
      : `Select ${AGENT_LABELS[selection.agent]} model`
  );
  const interactionLocked = disabled || selectionLockedReason !== null;
  const triggerClassName = triggerVariant === "picker"
    ? `h-9 min-w-0 shrink-0 justify-between gap-1 rounded-md px-2.5 text-[12px] font-medium text-foreground/80 ${
      interactionLocked
        ? "cursor-not-allowed opacity-50"
        : "hover:bg-secondary/40 hover:text-foreground"
    }`
    : `rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium text-muted-foreground ${
      interactionLocked
        ? "cursor-not-allowed opacity-50"
        : "hover:bg-secondary/70 hover:text-foreground"
    }`;
  const iconClassName = triggerVariant === "picker"
    ? "h-3.5 w-3.5 text-muted-foreground/80"
    : "h-3.5 w-3.5";
  const labelClassName = triggerVariant === "picker" ? "truncate" : "max-w-[160px] truncate";
  const triggerTextColorClassName = triggerVariant === "picker" ? "" : "text-muted-foreground";

  const renderModelOptionList = () => (
    <div className="h-[min(18rem,calc(100vh-10rem))] overflow-y-auto">
      {modelPreviewOptions.map((option, index) => {
        const selected = option.agent === selection.agent
          && option.model === selection.model
          && option.modelProviderId === selection.modelProviderId;
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
              disabled={interactionLocked}
              title={option.model}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                selected
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50"
              } disabled:cursor-not-allowed disabled:opacity-60`}
              onMouseDown={(event) => {
                event.preventDefault();
                if (interactionLocked) {
                  return;
                }
                onSelectionChange({
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
  );

  return (
    <div className={cn("relative", className)} ref={modelPopoverRef}>
      <button
        type="button"
        onClick={() => {
          if (interactionLocked) {
            return;
          }
          if (!modelPopoverOpen) {
            setModelPreviewAgent(selection.agent);
          }
          setModelPopoverOpen(!modelPopoverOpen);
        }}
        disabled={interactionLocked}
        title={selectionLockedReason ?? currentSelection.model}
        className={cn(
          "flex items-center transition-colors",
          triggerTextColorClassName,
          triggerClassName,
          customTriggerClassName,
        )}
        aria-label={resolvedAriaLabel}
      >
        <AgentIcon agent={selection.agent} aria-hidden="true" className={iconClassName} />
        <span className={labelClassName}>{modelLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {modelPopoverOpen ? (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-[210px]">
          {showAgentList ? (
            <div className="relative">
              <div className="rounded-xl border border-border/60 bg-popover p-1 shadow-lg">
                <div className="space-y-1" data-cli-agent-list="true">
                  {CLI_AGENTS.map((entryAgent) => {
                    const selectedAgent = modelPreviewAgent === entryAgent;
                    const currentAgent = selection.agent === entryAgent;

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
                          if (modelPreviewAgent !== entryAgent) {
                            setModelPreviewAgent(entryAgent);
                          }
                        }}
                        onFocus={() => {
                          if (modelPreviewAgent !== entryAgent) {
                            setModelPreviewAgent(entryAgent);
                          }
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          if (modelPreviewAgent !== entryAgent) {
                            setModelPreviewAgent(entryAgent);
                          }
                        }}
                      >
                        <AgentIcon agent={entryAgent} aria-hidden="true" className="h-4 w-4" />
                        <span className="min-w-0 flex-1 truncate">{AGENT_LABELS[entryAgent]}</span>
                        {currentAgent ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div
                data-agent-model-panel="overlay"
                className="absolute left-full top-0 z-10 ml-2 w-[250px] rounded-xl border border-border/60 bg-popover p-1 shadow-lg"
              >
                {renderModelOptionList()}
              </div>
            </div>
          ) : (
            <div
              data-agent-model-panel="single"
              className="w-[250px] rounded-xl border border-border/60 bg-popover p-1 shadow-lg"
            >
              <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
                {`Models for ${AGENT_LABELS[selection.agent]}`}
              </div>
              {renderModelOptionList()}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
