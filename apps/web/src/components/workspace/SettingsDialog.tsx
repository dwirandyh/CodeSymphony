import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bot,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FolderGit2,
  Keyboard,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ScrollText,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { AgentsSettingsPanel } from "./AgentsSettingsPanel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../ui/slider";
import { api } from "../../lib/api";
import {
  getDesktopNotificationPermission,
  openDesktopNotificationSettings,
  requestDesktopNotificationPermission,
  supportsDesktopNotifications,
  usesSystemManagedDesktopNotificationPermissions,
} from "../../lib/desktopNotifications";
import { isDesktopShell } from "../../lib/openExternalUrl";
import { queryKeys } from "../../lib/queryKeys";
import { THIRD_PARTY_LICENSES } from "../../lib/thirdPartyLicenses";
import { cn } from "../../lib/utils";
import {
  MODEL_PROVIDER_AGENTS_BY_COMPATIBILITY,
  type ClaudeModelCatalogEntry,
  type CliAgent,
  type CodexModelCatalogEntry,
  type CursorModelCatalogEntry,
  type ModelProvider,
  type ModelProviderCompatibility,
  type OpencodeModelCatalogEntry,
  type Repository,
  type SaveAutomationConfig,
} from "@codesymphony/shared-types";
import { resolveAgentDefaultModel } from "../../lib/agentModelDefaults";
import { useModelProviders } from "../../pages/workspace/hooks/useModelProviders";
import {
  loadAgentDefaults,
  saveAgentDefaults,
  type AgentDefaults,
  type AgentDefaultSelection,
} from "../../pages/workspace/agentDefaults";
import {
  COMPLETION_SOUND_VOLUME_MAX,
  COMPLETION_SOUND_VOLUME_MIN,
  getModifierEnterHint,
  getModifierEnterLabel,
  getShiftEnterHint,
  type GeneralSettings,
} from "../../lib/generalSettings";
import { COMPLETION_SOUND_OPTIONS, playCompletionSound } from "../../lib/completionSounds";
import {
  buildAgentSelectionOptions,
  formatFriendlyModelName,
  type AgentSelectionOption,
} from "./composer/AgentModelSelector";
import {
  getVisibleWorkspaceShortcutSections,
  getWorkspaceShortcutLabel,
  resolveWorkspaceShortcutPlatform,
} from "./keyboardShortcuts";

export type SettingsTab = "general" | "workspace" | "agents" | "models" | "shortcuts" | "licenses";
type SaveAutomationTemplate = "custom_generic" | "flutter_hot_reload";

const SETTINGS_TAB_DESCRIPTIONS: Record<SettingsTab, string> = {
  general: "Preferences, notifications, and completion feedback.",
  workspace: "Repository defaults, scripts, and save automation.",
  agents: "Custom CLI paths and credentials for each agent.",
  models: "Default agents and custom model providers.",
  shortcuts: "Keyboard shortcuts available in the workspace.",
  licenses: "Open source licenses bundled with the app.",
};

const DEFAULT_SAVE_AUTOMATION_TARGET = "active_run_session" as const;
const DEFAULT_SAVE_AUTOMATION_DEBOUNCE_MS = 400;
const FLUTTER_HOT_RELOAD_PATTERN = "lib/**/*.dart";
const FLUTTER_HOT_RELOAD_PAYLOAD = "r";
type RepositoryFormState = {
  runScriptText: string;
  setupText: string;
  teardownText: string;
  defaultBranchValue: string;
  saveAutomationEnabled: boolean;
  saveAutomationTemplate: SaveAutomationTemplate;
  saveAutomationFilePatternsText: string;
  saveAutomationPayload: string;
};

type ProviderProtocol = "anthropic" | "openai";

const PROVIDER_COMPATIBILITY_LABELS: Record<ModelProviderCompatibility, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const PROVIDER_COMPATIBILITY_ORDER: ModelProviderCompatibility[] = ["anthropic", "openai"];

const PROVIDER_VISIBLE_AGENT_LABELS: Record<CliAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

function getProviderBaseUrlError(baseUrl: string): string | null {
  if (baseUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return "Enter a valid http:// or https:// URL.";
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return "Enter a valid http:// or https:// URL.";
  }

  return null;
}

type AgentDefaultsKey = keyof AgentDefaults;

type AgentModelOption = {
  key: string;
  model: string;
  modelProviderId: string | null;
  label: string;
  detail: string;
  source: "builtin" | "custom";
};

type PreferenceToggleProps = {
  checked: boolean;
  ariaLabel: string;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
};

type GeneralPreferenceRowProps = {
  title: string;
  description: string;
  hint?: string | null;
  control: ReactNode;
  descriptionId: string;
};

type SettingsSectionProps = {
  title: string;
  description: string;
  hint?: string | null;
  descriptionId: string;
  action?: ReactNode;
  actionClassName?: string;
  children?: ReactNode;
};

type SettingsSelectOption = {
  value: string;
  label: string;
  detail?: string;
  source?: "builtin" | "custom";
  disabled?: boolean;
};

type SettingsSelectProps = {
  ariaLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SettingsSelectOption[];
  className?: string;
  describedBy?: string;
  itemClassName?: string;
  disabled?: boolean;
  placeholder?: string;
  visualVariant?: "default" | "model-detail";
};

function PreferenceToggle({
  checked,
  ariaLabel,
  disabled = false,
  onCheckedChange,
}: PreferenceToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors ${
        checked ? "border-foreground/30 bg-foreground/90" : "border-border/70 bg-secondary/20"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <span
        className={`mx-0.5 h-6 w-6 rounded-full bg-background shadow-sm transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function GeneralPreferenceRow({
  title,
  description,
  hint,
  control,
  descriptionId,
}: GeneralPreferenceRowProps) {
  return (
    <section className="border-t border-border/30 py-5 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p id={descriptionId} className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
          {hint ? (
            <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground/80">{hint}</p>
          ) : null}
        </div>
        <div className="w-full shrink-0 sm:w-auto">{control}</div>
      </div>
    </section>
  );
}

const SETTINGS_INPUT_CLASS_NAME =
  "w-full rounded-lg border border-border/60 bg-background/20 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30";

const SETTINGS_TEXTAREA_CLASS_NAME =
  "w-full rounded-lg border border-border/60 bg-background/20 px-3 py-2 font-mono text-[12px] leading-5 text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30";

function SettingsSection({
  title,
  description,
  hint,
  descriptionId,
  action,
  actionClassName,
  children,
}: SettingsSectionProps) {
  return (
    <section className="border-t border-border/30 py-5 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p id={descriptionId} className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
          {hint ? (
            <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground/80">{hint}</p>
          ) : null}
        </div>
        {action ? (
          <div className={cn("w-full md:max-w-[240px] md:shrink-0", actionClassName)}>
            {action}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

function SettingsDesktopAppBar() {
  return (
    <div
      className="sticky top-0 z-10 -mx-4 mb-4 h-[38px] bg-background"
      data-testid="settings-desktop-appbar"
      aria-hidden="true"
    />
  );
}

function renderSettingsSelectOptionContent(
  option: SettingsSelectOption,
  visualVariant: SettingsSelectProps["visualVariant"],
) {
  if (visualVariant !== "model-detail" || !option.detail) {
    return option.label;
  }

  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2 text-left">
      <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
      <span className="sr-only"> · </span>
      <span className="max-w-[7rem] shrink-0 truncate text-right text-[10px] text-muted-foreground">
        {option.detail}
      </span>
    </div>
  );
}

function renderSettingsSelectTriggerContent(
  option: SettingsSelectOption,
  visualVariant: SettingsSelectProps["visualVariant"],
) {
  if (visualVariant !== "model-detail") {
    return option.label;
  }

  return (
    <span className="min-w-0 flex-1 truncate text-left font-medium">
      {option.label}
    </span>
  );
}

function isFirstCustomSettingsSelectOption(
  options: readonly SettingsSelectOption[],
  index: number,
): boolean {
  return options[index]?.source === "custom"
    && (index === 0 || options[index - 1]?.source !== "custom");
}

function SettingsSelect({
  ariaLabel,
  value,
  onValueChange,
  options,
  className,
  describedBy,
  itemClassName,
  disabled = false,
  placeholder,
  visualVariant = "default",
}: SettingsSelectProps) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className={cn(
          "h-8 w-full rounded-md border border-border/50 bg-secondary/30 px-2 text-xs text-foreground focus:ring-1 focus:ring-primary/30 focus:ring-offset-0",
          className,
        )}
      >
        {visualVariant === "model-detail" && selectedOption ? (
          <div className="min-w-0 flex flex-1 items-center gap-2">
            {renderSettingsSelectTriggerContent(selectedOption, visualVariant)}
          </div>
        ) : (
          <SelectValue placeholder={placeholder} />
        )}
      </SelectTrigger>
      <SelectContent>
        {options.map((option, index) => (
          <div key={option.value}>
            {visualVariant === "model-detail" && isFirstCustomSettingsSelectOption(options, index) ? (
              <div
                data-model-separator="custom"
                className="mx-2.5 my-1 border-t border-border/60"
              />
            ) : null}
            <SelectItem
              value={option.value}
              disabled={option.disabled}
              className={cn("text-xs", itemClassName)}
            >
              {renderSettingsSelectOptionContent(option, visualVariant)}
            </SelectItem>
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}

function getProviderProtocol(compatibility: ModelProviderCompatibility | undefined | null): ProviderProtocol {
  return compatibility ?? "anthropic";
}

function getProviderCompatibilityLabel(compatibility: ModelProviderCompatibility | undefined | null): string {
  return PROVIDER_COMPATIBILITY_LABELS[compatibility ?? "anthropic"];
}

function formatSupportedAgentsForCompatibility(compatibility: ModelProviderCompatibility): string {
  const supportedAgents = MODEL_PROVIDER_AGENTS_BY_COMPATIBILITY[compatibility] ?? [];
  return supportedAgents
    .map((agent) => PROVIDER_VISIBLE_AGENT_LABELS[agent])
    .join(" and ");
}

function mapAgentSelectionOptionsToAgentModelOptions(options: AgentSelectionOption[]): AgentModelOption[] {
  return options.map((option) => ({
    key: option.id,
    model: option.model,
    modelProviderId: option.modelProviderId,
    label: option.label,
    detail: option.detail,
    source: option.source,
  }));
}

function normalizeAgentDefaultSelection(
  selection: AgentDefaultSelection,
  options: AgentModelOption[],
): AgentDefaultSelection {
  const matchingOption = options.find((option) => (
    option.model === selection.model
    && option.modelProviderId === selection.modelProviderId
  ));

  if (matchingOption) {
    return selection;
  }

  if (selection.modelProviderId === null && selection.model.trim().length > 0) {
    return {
      agent: selection.agent,
      model: selection.model.trim(),
      modelProviderId: null,
    };
  }

  const fallbackOption = options[0];
  if (fallbackOption) {
    return {
      agent: selection.agent,
      model: fallbackOption.model,
      modelProviderId: fallbackOption.modelProviderId,
    };
  }

  return {
    agent: selection.agent,
    model: resolveAgentDefaultModel(selection.agent),
    modelProviderId: null,
  };
}

function ensureAgentModelOptionVisible(
  options: AgentModelOption[],
  selection: AgentDefaultSelection,
): AgentModelOption[] {
  const matchingOption = options.find((option) => (
    option.model === selection.model
    && option.modelProviderId === selection.modelProviderId
  ));
  if (matchingOption) {
    return options;
  }

  return [{
    key: selection.modelProviderId ?? `${selection.agent}:${selection.model}:adhoc`,
    model: selection.model,
    modelProviderId: selection.modelProviderId,
    label: formatFriendlyModelName(selection.agent, selection.model),
    detail: selection.modelProviderId ? "Custom" : "Built-in",
    source: selection.modelProviderId ? "custom" : "builtin",
  }, ...options];
}

function buildRepositoryFormState(
  repository: Repository,
  cachedState?: RepositoryFormState,
): RepositoryFormState {
  if (cachedState) {
    return cachedState;
  }

  return {
    runScriptText: repository.runScript?.join("\n") ?? "",
    setupText: repository.setupScript?.join("\n") ?? "",
    teardownText: repository.teardownScript?.join("\n") ?? "",
    defaultBranchValue: repository.defaultBranch,
    saveAutomationEnabled: repository.saveAutomation?.enabled ?? false,
    saveAutomationTemplate: inferSaveAutomationTemplate({
      filePatternsText: repository.saveAutomation?.filePatterns.join("\n") ?? "",
      payload: repository.saveAutomation?.payload ?? "",
    }),
    saveAutomationFilePatternsText: repository.saveAutomation?.filePatterns.join("\n") ?? "",
    saveAutomationPayload: repository.saveAutomation?.payload ?? "",
  };
}

function parseMultilineInput(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function buildSaveAutomationInput(state: {
  enabled: boolean;
  filePatternsText: string;
  payload: string;
}): SaveAutomationConfig | null {
  if (!state.enabled) {
    return null;
  }

  const filePatterns = parseMultilineInput(state.filePatternsText);
  const payload = state.payload.trim();

  return {
    enabled: true,
    target: DEFAULT_SAVE_AUTOMATION_TARGET,
    filePatterns,
    actionType: "send_stdin",
    payload,
    debounceMs: DEFAULT_SAVE_AUTOMATION_DEBOUNCE_MS,
  };
}

function inferSaveAutomationTemplate(state: {
  filePatternsText: string;
  payload: string;
}): SaveAutomationTemplate {
  const filePatterns = parseMultilineInput(state.filePatternsText);
  const payload = state.payload.trim();

  if (filePatterns.length === 1 && filePatterns[0] === FLUTTER_HOT_RELOAD_PATTERN && payload === FLUTTER_HOT_RELOAD_PAYLOAD) {
    return "flutter_hot_reload";
  }

  return "custom_generic";
}

function resolveInitialRepositoryId(
  repositories: Repository[],
  selectedRepositoryId?: string | null,
): string | null {
  if (selectedRepositoryId && repositories.some((repository) => repository.id === selectedRepositoryId)) {
    return selectedRepositoryId;
  }

  return repositories[0]?.id ?? null;
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  repositories: Repository[];
  selectedRepositoryId?: string | null;
  claudeModels?: readonly ClaudeModelCatalogEntry[];
  codexModels?: readonly CodexModelCatalogEntry[];
  cursorModels?: readonly CursorModelCatalogEntry[];
  opencodeModels?: readonly OpencodeModelCatalogEntry[];
  modelCatalogsLoading?: boolean;
  generalSettings: GeneralSettings;
  runtimeLabel?: string | null;
  runtimeTitle?: string | null;
  onRemoveRepository: (id: string) => void;
  onGeneralSettingsChange: (next: GeneralSettings) => void;
  onOpenIssueReport?: () => void;
  onProvidersChanged?: (providers: ModelProvider[]) => void;
}

function isMacDesktopShell(): boolean {
  if (!isDesktopShell() || typeof navigator === "undefined") {
    return false;
  }

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const platform = navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform ?? "";

  return /mac/i.test(platform) || /mac os x/i.test(navigator.userAgent);
}

const SYSTEM_MANAGED_DESKTOP_NOTIFICATIONS_MESSAGE =
  "CodeSymphony uses native desktop notifications. If alerts do not appear, allow CodeSymphony in your OS notification settings.";

export function SettingsDialog({
  open,
  onClose,
  repositories,
  selectedRepositoryId,
  claudeModels = [],
  codexModels = [],
  cursorModels = [],
  opencodeModels = [],
  modelCatalogsLoading = false,
  generalSettings,
  runtimeLabel,
  runtimeTitle,
  onRemoveRepository,
  onGeneralSettingsChange,
  onOpenIssueReport,
  onProvidersChanged,
}: SettingsDialogProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [mobileActiveTab, setMobileActiveTab] = useState<SettingsTab | null>(null);
  const [desktopNotificationsMessage, setDesktopNotificationsMessage] = useState<string | null>(null);
  const [openingDesktopNotificationSettings, setOpeningDesktopNotificationSettings] = useState(false);
  const [testingCompletionSound, setTestingCompletionSound] = useState(false);
  const [shortcutSearchQuery, setShortcutSearchQuery] = useState("");
  const [clearingRuntimeCache, setClearingRuntimeCache] = useState(false);
  const [runtimeCacheMessage, setRuntimeCacheMessage] = useState<string | null>(null);

  // ── Workspace tab state ──
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [runScriptText, setRunScriptText] = useState("");
  const [setupText, setSetupText] = useState("");
  const [teardownText, setTeardownText] = useState("");
  const [defaultBranchValue, setDefaultBranchValue] = useState("");
  const [saveAutomationEnabled, setSaveAutomationEnabled] = useState(false);
  const [saveAutomationTemplate, setSaveAutomationTemplate] = useState<SaveAutomationTemplate>("custom_generic");
  const [saveAutomationFilePatternsText, setSaveAutomationFilePatternsText] = useState("");
  const [saveAutomationPayload, setSaveAutomationPayload] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const savedScriptsRef = useRef<Record<string, RepositoryFormState>>({});
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const hydratedRepoIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const {
    providers,
    loading: loadingProviders,
    refreshProviders,
    replaceProviders,
  } = useModelProviders();

  // Provider form state
  const [showProviderDialog, setShowProviderDialog] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerCompatibility, setProviderCompatibility] = useState<ModelProviderCompatibility>("anthropic");
  const [providerName, setProviderName] = useState("");
  const [providerModelId, setProviderModelId] = useState("");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [providerFormError, setProviderFormError] = useState<string | null>(null);
  const [expandedProviderIds, setExpandedProviderIds] = useState<Set<string>>(() => new Set());
  const [modelTestStatus, setModelTestStatus] = useState<
    Record<string, { state: "testing" | "success" | "error"; error?: string }>
  >({});
  const [addModelDialogProvider, setAddModelDialogProvider] = useState<ModelProvider | null>(null);
  const [addModelId, setAddModelId] = useState("");
  const [addModelError, setAddModelError] = useState<string | null>(null);
  const [savingAddModel, setSavingAddModel] = useState(false);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>(() => loadAgentDefaults());
  const providerProtocol = getProviderProtocol(providerCompatibility);
  const trimmedProviderName = providerName.trim();
  const trimmedProviderModelId = providerModelId.trim();
  const trimmedProviderBaseUrl = providerBaseUrl.trim();
  const trimmedProviderApiKey = providerApiKey.trim();
  const providerBaseUrlError = getProviderBaseUrlError(trimmedProviderBaseUrl);
  const hasValidProviderBaseUrl = trimmedProviderBaseUrl.length > 0 && providerBaseUrlError === null;
  const canSaveProvider = trimmedProviderName.length > 0
    && hasValidProviderBaseUrl
    && (editingProviderId !== null || trimmedProviderModelId.length > 0)
    && (editingProviderId !== null || trimmedProviderApiKey.length > 0);
  const canTestProvider = editingProviderId === null
    && hasValidProviderBaseUrl
    && trimmedProviderApiKey.length > 0
    && trimmedProviderModelId.length > 0;
  const providerModelPlaceholder = providerCompatibility === "anthropic"
    ? 'e.g. "claude-sonnet-4-6", "glm-4.7"'
    : 'e.g. "gpt-5.4", "gpt-5.3-codex"';
  const providerBaseUrlPlaceholder = providerCompatibility === "anthropic"
    ? "e.g. https://api.anthropic.com/v1"
    : "e.g. https://api.openai.com/v1 or https://lb.jatevo.ai/v1";
  const providerApiKeyPlaceholder = editingProviderId
    ? "Leave empty to keep current"
    : "API Key";
  const providerInlineHelp = providerCompatibility === "anthropic"
    ? "This provider will be available in Claude Code and OpenCode."
    : "This provider will be available in Codex and OpenCode. For Codex, the endpoint must implement the OpenAI Responses API. Chat-completions-only endpoints can still work in OpenCode.";
  const providerFootnote = "One provider has one API compatibility and endpoint. Add another provider entry for the same vendor when it also supports another compatibility.";
  const providerTestSuccessMessage = providerProtocol === "anthropic"
    ? "Provider test successful — Anthropic-compatible."
    : "Provider test successful — OpenAI Responses API is available.";
  const agentSelectionOptions = useMemo(
    () => buildAgentSelectionOptions({
      providers,
      claudeModels,
      codexModels,
      cursorModels,
      opencodeModels,
    }),
    [claudeModels, codexModels, cursorModels, opencodeModels, providers],
  );
  const agentModelOptions = useMemo<Record<CliAgent, AgentModelOption[]>>(() => ({
    claude: mapAgentSelectionOptionsToAgentModelOptions(agentSelectionOptions.claude),
    codex: mapAgentSelectionOptionsToAgentModelOptions(agentSelectionOptions.codex),
    cursor: mapAgentSelectionOptionsToAgentModelOptions(agentSelectionOptions.cursor),
    opencode: mapAgentSelectionOptionsToAgentModelOptions(agentSelectionOptions.opencode),
  }), [agentSelectionOptions]);
  const visibleAgentModelOptions = useMemo(() => ({
    newChat: ensureAgentModelOptionVisible(agentModelOptions[agentDefaults.newChat.agent], agentDefaults.newChat),
    commit: ensureAgentModelOptionVisible(agentModelOptions[agentDefaults.commit.agent], agentDefaults.commit),
    pullRequest: ensureAgentModelOptionVisible(agentModelOptions[agentDefaults.pullRequest.agent], agentDefaults.pullRequest),
  }), [agentDefaults.commit, agentDefaults.newChat, agentDefaults.pullRequest, agentModelOptions]);

  const resolvedAgentDefaults = useMemo<AgentDefaults>(() => ({
    newChat: normalizeAgentDefaultSelection(agentDefaults.newChat, visibleAgentModelOptions.newChat),
    commit: normalizeAgentDefaultSelection(agentDefaults.commit, visibleAgentModelOptions.commit),
    pullRequest: normalizeAgentDefaultSelection(agentDefaults.pullRequest, visibleAgentModelOptions.pullRequest),
  }), [agentDefaults, visibleAgentModelOptions]);
  const loadingModels = loadingProviders || modelCatalogsLoading;

  // ── Workspace: Select first repo ──
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      hydratedRepoIdRef.current = null;
      return;
    }

    if (wasOpenRef.current) {
      return;
    }

    wasOpenRef.current = true;
    hydratedRepoIdRef.current = null;
    setActiveTab("general");
    setMobileActiveTab(null);
    setShowRemoveDialog(false);
    setSelectedRepoId(resolveInitialRepositoryId(repositories, selectedRepositoryId));
  }, [open, repositories, selectedRepositoryId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (repositories.length === 0) {
      if (selectedRepoId !== null) {
        setSelectedRepoId(null);
      }
      return;
    }

    if (selectedRepoId && repositories.some((repo) => repo.id === selectedRepoId)) {
      return;
    }

    hydratedRepoIdRef.current = null;
    setSelectedRepoId(resolveInitialRepositoryId(repositories, selectedRepositoryId));
  }, [open, repositories, selectedRepoId, selectedRepositoryId]);

  // ── Workspace: Load scripts ──
  useEffect(() => {
    if (!open) return;

    const effectiveSelectedRepoId = repositories.some((candidate) => candidate.id === selectedRepoId)
      ? selectedRepoId
      : resolveInitialRepositoryId(repositories, selectedRepositoryId);
    if (!effectiveSelectedRepoId) return;

    const repo = repositories.find((candidate) => candidate.id === effectiveSelectedRepoId);
    if (!repo) return;

    const repoChanged = hydratedRepoIdRef.current !== effectiveSelectedRepoId;
    if (!repoChanged && dirty) {
      return;
    }

    const nextState = buildRepositoryFormState(repo, savedScriptsRef.current[effectiveSelectedRepoId]);
    setRunScriptText(nextState.runScriptText);
    setSetupText(nextState.setupText);
    setTeardownText(nextState.teardownText);
    setDefaultBranchValue(nextState.defaultBranchValue);
    setSaveAutomationEnabled(nextState.saveAutomationEnabled);
    setSaveAutomationTemplate(nextState.saveAutomationTemplate);
    setSaveAutomationFilePatternsText(nextState.saveAutomationFilePatternsText);
    setSaveAutomationPayload(nextState.saveAutomationPayload);
    hydratedRepoIdRef.current = effectiveSelectedRepoId;
    setDirty(false);
    setShowRemoveDialog(false);
  }, [dirty, open, repositories, selectedRepoId, selectedRepositoryId]);

  // ── Workspace: Fetch branches ──
  useEffect(() => {
    if (!selectedRepoId) return;
    let cancelled = false;
    setLoadingBranches(true);
    api.listBranches(selectedRepoId)
      .then((data) => { if (!cancelled) setBranches(data); })
      .catch(() => { if (!cancelled) setBranches([]); })
      .finally(() => { if (!cancelled) setLoadingBranches(false); });
    return () => { cancelled = true; };
  }, [selectedRepoId]);

  useEffect(() => {
    if (!open || activeTab !== "models") {
      return;
    }

    void refreshProviders().catch(() => {});
  }, [activeTab, open, refreshProviders]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Prefetch agent config as soon as Settings opens so the Agents tab is
    // populated instantly when selected, instead of showing a loading state.
    void queryClient.prefetchQuery({
      queryKey: queryKeys.agentConfig.all,
      queryFn: () => api.getAgentConfig(),
      staleTime: 60_000,
    });
  }, [open, queryClient]);

  useEffect(() => {
    onProvidersChanged?.(providers);
  }, [onProvidersChanged, providers]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setAgentDefaults(loadAgentDefaults());
  }, [open]);

  useEffect(() => {
    if (!open || !generalSettings.desktopNotificationsEnabled) {
      setDesktopNotificationsMessage(null);
      return;
    }

    if (usesSystemManagedDesktopNotificationPermissions()) {
      setDesktopNotificationsMessage(SYSTEM_MANAGED_DESKTOP_NOTIFICATIONS_MESSAGE);
      return;
    }

    if (!supportsDesktopNotifications()) {
      setDesktopNotificationsMessage("This app does not support desktop notifications.");
      return;
    }

    let cancelled = false;
    void getDesktopNotificationPermission()
      .then((permission) => {
        if (cancelled) {
          return;
        }

        if (permission === "granted") {
          setDesktopNotificationsMessage(null);
          return;
        }

        setDesktopNotificationsMessage("Desktop notifications are not currently allowed for this app.");
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopNotificationsMessage("This app could not verify desktop notification permission.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [generalSettings.desktopNotificationsEnabled, open]);

  useEffect(() => {
    setAgentDefaults((current) => {
      const next = {
        newChat: normalizeAgentDefaultSelection(current.newChat, agentModelOptions[current.newChat.agent]),
        commit: normalizeAgentDefaultSelection(current.commit, agentModelOptions[current.commit.agent]),
        pullRequest: normalizeAgentDefaultSelection(current.pullRequest, agentModelOptions[current.pullRequest.agent]),
      };

      const changed =
        next.newChat.agent !== current.newChat.agent
        || next.newChat.model !== current.newChat.model
        || next.newChat.modelProviderId !== current.newChat.modelProviderId
        || next.commit.agent !== current.commit.agent
        || next.commit.model !== current.commit.model
        || next.commit.modelProviderId !== current.commit.modelProviderId
        || next.pullRequest.agent !== current.pullRequest.agent
        || next.pullRequest.model !== current.pullRequest.model
        || next.pullRequest.modelProviderId !== current.pullRequest.modelProviderId;

      if (!changed) {
        return current;
      }

      return saveAgentDefaults(next);
    });
  }, [agentModelOptions]);

  const resetProviderForm = useCallback((nextCompatibility: ModelProviderCompatibility = "anthropic") => {
    setEditingProviderId(null);
    setProviderCompatibility(nextCompatibility);
    setProviderName("");
    setProviderModelId("");
    setProviderBaseUrl("");
    setProviderApiKey("");
    setShowProviderDialog(false);
    setTestResult(null);
    setProviderFormError(null);
  }, []);

  const parseScriptLines = useCallback((scriptText: string): string[] | null => {
    const lines = parseMultilineInput(scriptText);
    return lines.length > 0 ? lines : null;
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedRepoId) return;
    if (savePromiseRef.current) {
      await savePromiseRef.current;
      return;
    }

    const savePromise = (async () => {
      setSaving(true);
      try {
        const runScriptLines = parseScriptLines(runScriptText);
        const setupLines = parseScriptLines(setupText);
        const teardownLines = parseScriptLines(teardownText);
        const saveAutomation = buildSaveAutomationInput({
          enabled: saveAutomationEnabled,
          filePatternsText: saveAutomationFilePatternsText,
          payload: saveAutomationPayload,
        });
        const repo = repositories.find((r) => r.id === selectedRepoId);
        const branchChanged = repo && defaultBranchValue !== repo.defaultBranch;
        const updatedRepository = await api.updateRepositoryScripts(selectedRepoId, {
          runScript: runScriptLines,
          setupScript: setupLines,
          teardownScript: teardownLines,
          saveAutomation,
          ...(branchChanged ? { defaultBranch: defaultBranchValue } : {}),
        });

        queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (current) => {
          if (!current) return current;
          return current.map((repository) =>
            repository.id === selectedRepoId ? updatedRepository : repository,
          );
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });

        savedScriptsRef.current[selectedRepoId] = {
          runScriptText: updatedRepository.runScript?.join("\n") ?? "",
          setupText: updatedRepository.setupScript?.join("\n") ?? "",
          teardownText: updatedRepository.teardownScript?.join("\n") ?? "",
          defaultBranchValue: updatedRepository.defaultBranch,
          saveAutomationEnabled: updatedRepository.saveAutomation?.enabled ?? false,
          saveAutomationTemplate: inferSaveAutomationTemplate({
            filePatternsText: updatedRepository.saveAutomation?.filePatterns.join("\n") ?? "",
            payload: updatedRepository.saveAutomation?.payload ?? "",
          }),
          saveAutomationFilePatternsText: updatedRepository.saveAutomation?.filePatterns.join("\n") ?? "",
          saveAutomationPayload: updatedRepository.saveAutomation?.payload ?? "",
        };
        hydratedRepoIdRef.current = selectedRepoId;
        setDirty(false);
      } catch {
        // Error is non-critical; user can retry
      } finally {
        savePromiseRef.current = null;
        setSaving(false);
      }
    })();

    savePromiseRef.current = savePromise;
    await savePromise;
  }, [defaultBranchValue, parseScriptLines, queryClient, repositories, runScriptText, saveAutomationEnabled, saveAutomationFilePatternsText, saveAutomationPayload, selectedRepoId, setupText, teardownText]);

  const handleCloseSettings = useCallback(async () => {
    if (dirty || savePromiseRef.current) {
      await handleSave();
    }
    onClose();
  }, [dirty, handleSave, onClose]);

  const handleMobileBack = useCallback(() => {
    if (mobileActiveTab) {
      setMobileActiveTab(null);
      return;
    }

    void handleCloseSettings();
  }, [handleCloseSettings, mobileActiveTab]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || showProviderDialog || showRemoveDialog) {
        return;
      }

      event.preventDefault();
      void handleCloseSettings();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleCloseSettings, open, showProviderDialog, showRemoveDialog]);

  // Auto-save effect
  useEffect(() => {
    if (!dirty) return;
    const timeoutId = setTimeout(() => { void handleSave(); }, 1000);
    return () => clearTimeout(timeoutId);
  }, [dirty, handleSave]);

  const handleSaveProvider = useCallback(async () => {
    if (!canSaveProvider) return;
    setSavingProvider(true);
    setProviderFormError(null);
    try {
      let nextProvider: ModelProvider;
      if (editingProviderId) {
        nextProvider = await api.updateModelProvider(editingProviderId, {
          name: trimmedProviderName,
          compatibility: providerCompatibility,
          baseUrl: trimmedProviderBaseUrl,
          ...(trimmedProviderApiKey.length > 0 ? { apiKey: trimmedProviderApiKey } : {}),
        });
      } else {
        nextProvider = await api.createModelProvider({
          name: trimmedProviderName,
          compatibility: providerCompatibility,
          baseUrl: trimmedProviderBaseUrl,
          apiKey: trimmedProviderApiKey,
          models: [{ modelId: trimmedProviderModelId }],
        });
      }
      replaceProviders([
        ...providers.filter((provider) => provider.id !== nextProvider.id),
        nextProvider,
      ]);
      void refreshProviders().catch(() => {});
      resetProviderForm(providerCompatibility);
    } catch (error) {
      setProviderFormError(error instanceof Error ? error.message : "Failed to save provider");
    } finally {
      setSavingProvider(false);
    }
  }, [
    canSaveProvider,
    editingProviderId,
    providerCompatibility,
    providers,
    refreshProviders,
    replaceProviders,
    resetProviderForm,
    trimmedProviderApiKey,
    trimmedProviderBaseUrl,
    trimmedProviderModelId,
    trimmedProviderName,
  ]);

  const handleDeleteProvider = useCallback(async (id: string) => {
    try {
      await api.deleteModelProvider(id);
      replaceProviders(providers.filter((provider) => provider.id !== id));
    } catch {}
  }, [providers, replaceProviders]);

  const upsertProviderInList = useCallback((nextProvider: ModelProvider) => {
    replaceProviders([
      ...providers.filter((provider) => provider.id !== nextProvider.id),
      nextProvider,
    ]);
  }, [providers, replaceProviders]);

  const closeAddModelDialog = useCallback(() => {
    setAddModelDialogProvider(null);
    setAddModelId("");
    setAddModelError(null);
  }, []);

  const openAddModelDialog = useCallback((provider: ModelProvider) => {
    setAddModelDialogProvider(provider);
    setAddModelId("");
    setAddModelError(null);
  }, []);

  const handleAddProviderModel = useCallback(async () => {
    if (!addModelDialogProvider) {
      return;
    }

    const modelId = addModelId.trim();
    if (!modelId) {
      setAddModelError("Model ID is required.");
      return;
    }

    setSavingAddModel(true);
    setAddModelError(null);
    try {
      const nextProvider = await api.createModelProviderModel(addModelDialogProvider.id, { modelId });
      upsertProviderInList(nextProvider);
      closeAddModelDialog();
    } catch (error) {
      setAddModelError(error instanceof Error ? error.message : "Failed to add model.");
    } finally {
      setSavingAddModel(false);
    }
  }, [addModelDialogProvider, addModelId, closeAddModelDialog, upsertProviderInList]);

  const handleDeleteProviderModel = useCallback(async (provider: ModelProvider, modelRowId: string) => {
    try {
      await api.deleteModelProviderModel(modelRowId);
      upsertProviderInList({
        ...provider,
        models: (provider.models ?? []).filter((model) => model.id !== modelRowId),
      });
      setModelTestStatus((current) => {
        if (!(modelRowId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[modelRowId];
        return next;
      });
    } catch {}
  }, [upsertProviderInList]);

  const handleTestProviderModel = useCallback(async (
    providerId: string,
    modelRowId: string,
    modelId: string,
  ) => {
    setModelTestStatus((current) => ({ ...current, [modelRowId]: { state: "testing" } }));
    try {
      const result = await api.testModelProvider({ providerId, modelId });
      setModelTestStatus((current) => ({
        ...current,
        [modelRowId]: result.success
          ? { state: "success" }
          : { state: "error", error: result.error },
      }));
    } catch {
      setModelTestStatus((current) => ({
        ...current,
        [modelRowId]: { state: "error", error: "Network error — could not reach the runtime" },
      }));
    }
  }, []);

  const toggleProviderExpanded = useCallback((providerId: string) => {
    setExpandedProviderIds((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  }, []);

  const handleEditProvider = useCallback((provider: ModelProvider) => {
    setEditingProviderId(provider.id);
    setProviderCompatibility(provider.compatibility);
    setProviderName(provider.name);
    setProviderModelId("");
    setProviderBaseUrl(provider.baseUrl ?? "");
    setProviderApiKey("");
    setShowProviderDialog(true);
    setTestResult(null);
  }, []);

  const handleTestProvider = useCallback(async () => {
    if (!canTestProvider) return;
    setTestingProvider(true);
    setTestResult(null);
    try {
      const result = await api.testModelProvider({
        compatibility: providerCompatibility,
        baseUrl: trimmedProviderBaseUrl,
        apiKey: trimmedProviderApiKey,
        modelId: trimmedProviderModelId,
      });
      setTestResult(result);
    } catch {
      setTestResult({ success: false, error: "Network error — could not reach the runtime" });
    } finally {
      setTestingProvider(false);
    }
  }, [canTestProvider, providerCompatibility, trimmedProviderApiKey, trimmedProviderBaseUrl, trimmedProviderModelId]);

  const updateAgentDefault = useCallback((
    key: AgentDefaultsKey,
    updater: (current: AgentDefaultSelection) => AgentDefaultSelection,
  ) => {
    setAgentDefaults((current) => {
      const nextSelection = updater(current[key]);
      const next = {
        ...current,
        [key]: nextSelection,
      };
      return saveAgentDefaults(next);
    });
  }, []);

  const handleClearRuntimeCache = useCallback(async () => {
    setClearingRuntimeCache(true);
    setRuntimeCacheMessage(null);
    try {
      await api.clearRuntimeCache();
      await queryClient.invalidateQueries();
      setRuntimeCacheMessage("Runtime cache cleared (model lists, slash commands, git snapshots, app icons). Data reloads on next use.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clear runtime cache";
      setRuntimeCacheMessage(message);
    } finally {
      setClearingRuntimeCache(false);
    }
  }, [queryClient]);

  const handleDesktopNotificationsToggle = useCallback(async (checked: boolean) => {
    if (!checked) {
      setDesktopNotificationsMessage(null);
      onGeneralSettingsChange({
        ...generalSettings,
        desktopNotificationsEnabled: false,
      });
      return;
    }

    if (usesSystemManagedDesktopNotificationPermissions()) {
      setDesktopNotificationsMessage(SYSTEM_MANAGED_DESKTOP_NOTIFICATIONS_MESSAGE);
      onGeneralSettingsChange({
        ...generalSettings,
        desktopNotificationsEnabled: true,
      });
      return;
    }

    if (!supportsDesktopNotifications()) {
      setDesktopNotificationsMessage("This app does not support desktop notifications.");
      return;
    }

    const permission = await requestDesktopNotificationPermission();
    if (permission !== "granted") {
      setDesktopNotificationsMessage("Desktop notifications remain disabled because permission was not granted.");
      onGeneralSettingsChange({
        ...generalSettings,
        desktopNotificationsEnabled: false,
      });
      return;
    }

    setDesktopNotificationsMessage(null);
    onGeneralSettingsChange({
      ...generalSettings,
      desktopNotificationsEnabled: true,
    });
  }, [generalSettings, onGeneralSettingsChange]);

  const handleOpenDesktopNotificationSettings = useCallback(async () => {
    setOpeningDesktopNotificationSettings(true);
    try {
      const opened = await openDesktopNotificationSettings();
      if (!opened) {
        setDesktopNotificationsMessage("CodeSymphony could not open macOS Notification Settings automatically.");
      }
    } finally {
      setOpeningDesktopNotificationSettings(false);
    }
  }, []);

  const handleTestCompletionSound = useCallback(async () => {
    if (generalSettings.completionSound === "off") {
      return;
    }

    setTestingCompletionSound(true);
    try {
      await playCompletionSound(generalSettings.completionSound, generalSettings.completionSoundVolume);
    } finally {
      setTestingCompletionSound(false);
    }
  }, [generalSettings.completionSound, generalSettings.completionSoundVolume]);

  const selectedRepo = repositories.find((r) => r.id === selectedRepoId) ?? null;
  const macDesktopShell = isMacDesktopShell();
  const sendMessagesHint = generalSettings.sendMessagesWith === "enter"
    ? `Use ${getShiftEnterHint()} for new lines.`
    : `Use Enter for new lines. Send with ${getModifierEnterHint()}.`;
  const completionAttentionHint = "Completion alerts are suppressed when the finished chat is already visible and focused.";
  const shortcutPlatform = resolveWorkspaceShortcutPlatform();
  const shortcutSections = getVisibleWorkspaceShortcutSections(shortcutPlatform);
  const normalizedShortcutSearchQuery = shortcutSearchQuery.trim().toLowerCase();
  const filteredShortcutSections = normalizedShortcutSearchQuery.length === 0
    ? shortcutSections
    : shortcutSections.map((section) => ({
      ...section,
      shortcuts: section.shortcuts.filter((shortcut) => (
        shortcut.label.toLowerCase().includes(normalizedShortcutSearchQuery)
        || shortcut.description.toLowerCase().includes(normalizedShortcutSearchQuery)
        || shortcut.scope.toLowerCase().includes(normalizedShortcutSearchQuery)
        || (getWorkspaceShortcutLabel(shortcut, shortcutPlatform)?.toLowerCase().includes(normalizedShortcutSearchQuery) ?? false)
      )),
    })).filter((section) => section.shortcuts.length > 0);
  const primarySettingsTabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: "General" },
    { id: "workspace", label: "Workspace" },
    { id: "agents", label: "Agents" },
    { id: "models", label: "Models" },
    { id: "shortcuts", label: "Shortcuts" },
  ];
  const aboutSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "licenses", label: "Licenses" },
  ];
  const mobileSettingsTabs = [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "workspace", label: "Workspace", icon: FolderGit2 },
    { id: "agents", label: "Agents", icon: Bot },
    { id: "models", label: "Models", icon: Bot },
    { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
    { id: "licenses", label: "Licenses", icon: ScrollText },
  ] satisfies Array<{ id: SettingsTab; label: string; icon: LucideIcon }>;
  const activeTabLabel = mobileSettingsTabs.find((tab) => tab.id === activeTab)?.label ?? "Settings";

  if (!open) return null;

  return (
    <>
      {/* Full-page overlay */}
      <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background md:flex-row">
        <aside
          className={cn(
            "hidden w-[232px] shrink-0 flex-col border-r border-border/30 bg-card/60 px-4 pb-4 md:flex",
            macDesktopShell ? "pt-[46px]" : "pt-3",
          )}
          data-testid="settings-sidebar"
        >
          <button
            type="button"
            className="mb-5 flex items-center gap-2 px-1 py-1 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close settings"
            onClick={() => { void handleCloseSettings(); }}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm font-semibold text-foreground">Settings</span>
          </button>

          <div className="space-y-5" data-testid="settings-navigation">
            <div>
              <div className="mb-2 px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                Settings
              </div>
              <div className="space-y-1">
                {primarySettingsTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                      activeTab === tab.id
                        ? "bg-secondary/40 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-secondary/20 hover:text-foreground",
                    )}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                About
              </div>
              <div className="space-y-1">
                {aboutSettingsTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                      activeTab === tab.id
                        ? "bg-secondary/40 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-secondary/20 hover:text-foreground",
                    )}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {runtimeLabel ? (
            <div className="mt-auto pt-4">
              <div className="border-t border-border/30 pt-3">
                <div className="text-[10px] text-muted-foreground">
                  <div className="mb-1 uppercase tracking-[0.12em] text-muted-foreground/70">Runtime</div>
                  <div
                    className="truncate text-[11px] font-medium text-foreground/80"
                    title={runtimeTitle ?? undefined}
                    data-testid="settings-runtime-context"
                  >
                    {runtimeLabel}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </aside>

        <div className="flex shrink-0 flex-col border-b border-border/30 bg-card/60 md:hidden">
          {macDesktopShell ? <SettingsDesktopAppBar /> : null}
          <div className="flex h-12 items-center px-3">
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold text-foreground"
              onClick={handleMobileBack}
              aria-label={mobileActiveTab ? "Back to settings" : "Close settings"}
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              <span className="truncate">{mobileActiveTab ? activeTabLabel : "Settings"}</span>
            </button>
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-4",
            mobileActiveTab ? "hidden" : "block",
            "md:hidden",
          )}
          data-testid="settings-mobile-menu"
        >
          <div className="space-y-1">
            {mobileSettingsTabs.map((tab) => {
              const Icon = tab.icon;

              return (
                <button
                  key={tab.id}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-secondary/40"
                  onClick={() => {
                    setActiveTab(tab.id);
                    setMobileActiveTab(tab.id);
                  }}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/40 text-muted-foreground">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-foreground">{tab.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                      {SETTINGS_TAB_DESCRIPTIONS[tab.id]}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                </button>
              );
            })}
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 flex-col overflow-y-auto p-4",
            mobileActiveTab ? "flex" : "hidden",
            "md:flex",
          )}
          data-testid="settings-content"
        >
          {macDesktopShell ? <SettingsDesktopAppBar /> : null}

          <div className="mb-4 md:hidden">
            <h1 className="text-xl font-semibold text-foreground">{activeTabLabel}</h1>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              {SETTINGS_TAB_DESCRIPTIONS[activeTab]}
            </p>
          </div>

          <div className={`mx-auto w-full ${activeTab === "licenses" || activeTab === "shortcuts" ? "max-w-4xl" : "max-w-5xl"}`}>
            {activeTab === "general" ? (
              <div className="space-y-5">
                <div className="hidden md:block">
                  <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">General</h1>
                </div>

                <div className="space-y-0">
                  <GeneralPreferenceRow
                    title="Send messages with"
                    description="Choose which key combination sends messages."
                    hint={sendMessagesHint}
                    descriptionId="general-send-messages-description"
                    control={(
                      <SettingsSelect
                        ariaLabel="Send messages with"
                        value={generalSettings.sendMessagesWith}
                        onValueChange={(value) => onGeneralSettingsChange({
                          ...generalSettings,
                          sendMessagesWith: value === "mod_enter" ? "mod_enter" : "enter",
                        })}
                        describedBy="general-send-messages-description"
                        className="min-w-[200px] rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                        itemClassName="text-[13px]"
                        options={[
                          { value: "enter", label: "Enter" },
                          { value: "mod_enter", label: getModifierEnterLabel() },
                        ]}
                      />
                    )}
                  />

                  <GeneralPreferenceRow
                    title="Desktop notifications"
                    description="Get notified when AI finishes working in a chat."
                    hint={desktopNotificationsMessage ?? completionAttentionHint}
                    descriptionId="general-desktop-notifications-description"
                    control={(
                      <div className="flex flex-col items-end gap-2">
                        <PreferenceToggle
                          checked={generalSettings.desktopNotificationsEnabled}
                          ariaLabel="Desktop notifications"
                          onCheckedChange={(checked) => {
                            void handleDesktopNotificationsToggle(checked);
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px] text-muted-foreground"
                          onClick={() => {
                            void handleOpenDesktopNotificationSettings();
                          }}
                          disabled={openingDesktopNotificationSettings}
                        >
                          {openingDesktopNotificationSettings ? "Opening…" : "Open Notification Settings"}
                        </Button>
                      </div>
                    )}
                  />

                  <SettingsSection
                    title="Completion sound"
                    description="Choose what plays when AI finishes working in a chat."
                    descriptionId="general-completion-sound-description"
                    action={(
                      <div className="flex items-center gap-2.5">
                        <SettingsSelect
                          ariaLabel="Completion sound"
                          value={generalSettings.completionSound}
                          onValueChange={(value) => onGeneralSettingsChange({
                            ...generalSettings,
                            completionSound: value === "chime"
                              || value === "ding"
                              || value === "pop"
                              ? value
                              : "off",
                          })}
                          describedBy="general-completion-sound-description"
                          className="min-w-[200px] rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                          itemClassName="text-[13px]"
                          options={COMPLETION_SOUND_OPTIONS.map((option) => ({
                            value: option.value,
                            label: option.label,
                          }))}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          aria-label="Test completion sound"
                          title="Play completion sound"
                          disabled={generalSettings.completionSound === "off" || testingCompletionSound}
                          onClick={() => {
                            void handleTestCompletionSound();
                          }}
                        >
                          {testingCompletionSound ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Play className="h-3.5 w-3.5 fill-current" />
                          )}
                        </Button>
                      </div>
                    )}
                    actionClassName="md:max-w-[250px]"
                  >
                    <div className="flex w-full items-center gap-3 md:ml-auto md:w-[250px]">
                      <Slider
                        aria-label="Completion sound volume"
                        aria-describedby="general-completion-sound-description"
                        min={COMPLETION_SOUND_VOLUME_MIN}
                        max={COMPLETION_SOUND_VOLUME_MAX}
                        step={5}
                        disabled={generalSettings.completionSound === "off"}
                        value={[generalSettings.completionSoundVolume]}
                        onValueChange={(values) => onGeneralSettingsChange({
                          ...generalSettings,
                          completionSoundVolume: values[0] ?? generalSettings.completionSoundVolume,
                        })}
                        className="flex-1"
                      />
                      <span className="w-11 text-right text-[13px] font-medium tabular-nums text-foreground">
                        {generalSettings.completionSoundVolume}%
                      </span>
                    </div>
                  </SettingsSection>

                  <GeneralPreferenceRow
                    title="Auto-convert long text"
                    description="Convert pasted text over 5000 characters into text attachments."
                    descriptionId="general-auto-convert-description"
                    control={(
                      <PreferenceToggle
                        checked={generalSettings.autoConvertLongTextEnabled}
                        ariaLabel="Auto-convert long text"
                        onCheckedChange={(checked) => onGeneralSettingsChange({
                          ...generalSettings,
                          autoConvertLongTextEnabled: checked,
                        })}
                      />
                    )}
                  />

                  <SettingsSection
                    title="Runtime cache"
                    description="Clears on-disk and in-memory runtime caches: model catalogs, slash-command catalogs, short-lived git snapshots, and generated app icons."
                    descriptionId="general-runtime-cache-description"
                    actionClassName="w-auto md:max-w-none"
                    action={(
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 px-3 text-[13px]"
                        disabled={clearingRuntimeCache}
                        onClick={() => {
                          void handleClearRuntimeCache();
                        }}
                      >
                        {clearingRuntimeCache ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Clear cache
                      </Button>
                    )}
                  >
                    {runtimeCacheMessage ? (
                      <p className="text-[11px] leading-5 text-muted-foreground" role="status">
                        {runtimeCacheMessage}
                      </p>
                    ) : null}
                  </SettingsSection>

                  <SettingsSection
                    title="Diagnostics"
                    description="Issue reports are saved locally with redacted runtime and workspace diagnostics."
                    descriptionId="general-diagnostics-description"
                    actionClassName="w-auto md:max-w-none"
                    action={(
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        className="min-w-32 justify-center gap-2 px-3 text-[13px]"
                        onClick={onOpenIssueReport}
                      >
                        <Bug className="h-3.5 w-3.5" />
                        Report Issue
                      </Button>
                    )}
                  />
                </div>
              </div>
            ) : activeTab === "workspace" ? (
              <div className="space-y-5">
                <div className="hidden md:block">
                  <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">Workspace</h1>
                  <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
                    Configure repository defaults, save automation, and lifecycle scripts for your local workspace.
                  </p>
                </div>

                {repositories.length > 0 ? (
                  <>
                    <div className="space-y-0">
                      <SettingsSection
                        title="Repository"
                        description="Choose which repository settings to edit."
                        descriptionId="workspace-repository-description"
                        action={(
                          <SettingsSelect
                            ariaLabel="Repository"
                            value={selectedRepoId ?? ""}
                            onValueChange={(value) => setSelectedRepoId(value)}
                            describedBy="workspace-repository-description"
                            className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                            itemClassName="text-[13px]"
                            options={repositories.map((repo) => ({
                              value: repo.id,
                              label: repo.name,
                            }))}
                          />
                        )}
                      >
                        {selectedRepo ? (
                          <p className="text-[11px] leading-5 text-muted-foreground/80">
                            Editing <span className="font-medium text-foreground">{selectedRepo.name}</span>
                            <span className="mx-1.5 text-muted-foreground/50">·</span>
                            <code className="rounded bg-secondary/40 px-1.5 py-0.5 text-[10px]">
                              {selectedRepo.rootPath}
                            </code>
                          </p>
                        ) : null}
                      </SettingsSection>

                      <SettingsSection
                        title="Default Branch"
                        description="New worktrees will be created from this branch."
                        descriptionId="workspace-default-branch-description"
                        action={loadingBranches ? (
                          <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-background/20 px-3 text-[13px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading branches...
                          </div>
                        ) : (
                          <SettingsSelect
                            ariaLabel="Default Branch"
                            value={defaultBranchValue}
                            onValueChange={(value) => { setDefaultBranchValue(value); setDirty(true); }}
                            describedBy="workspace-default-branch-description"
                            className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                            itemClassName="text-[13px]"
                            options={[
                              ...(!branches.includes(defaultBranchValue) && defaultBranchValue
                                ? [{ value: defaultBranchValue, label: defaultBranchValue }]
                                : []),
                              ...branches.map((branch) => ({
                                value: branch,
                                label: branch,
                              })),
                            ]}
                          />
                        )}
                      />

                      <SettingsSection
                        title="Run Script"
                        description="One command per line. Executed when you tap the Run button in the chat panel."
                        descriptionId="workspace-run-script-description"
                      >
                        <textarea
                          aria-label="Run Script"
                          className={SETTINGS_TEXTAREA_CLASS_NAME}
                          rows={3}
                          placeholder={"npm run dev\ndocker-compose up"}
                          value={runScriptText}
                          onChange={(e) => { setRunScriptText(e.target.value); setDirty(true); }}
                        />
                      </SettingsSection>

                      <SettingsSection
                        title="Save Automation"
                        description="When a saved file matches, send text to the active Run session or workspace terminal."
                        descriptionId="workspace-save-automation-description"
                        action={(
                          <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/20 px-3 py-2 text-[13px] text-foreground">
                            <span>Enabled</span>
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-border/50"
                              checked={saveAutomationEnabled}
                              onChange={(e) => { setSaveAutomationEnabled(e.target.checked); setDirty(true); }}
                            />
                          </label>
                        )}
                        actionClassName="md:max-w-[170px]"
                      >
                        {saveAutomationEnabled ? (
                          <div className="rounded-xl border border-border/40 bg-secondary/10 p-3">
                            <div className="grid gap-3 md:grid-cols-2">
                              <div className="space-y-1.5">
                                <label className="block text-[11px] font-medium text-foreground">Preset</label>
                                <SettingsSelect
                                  ariaLabel="Save automation preset"
                                  value={saveAutomationTemplate}
                                  onValueChange={(value) => {
                                    const nextTemplate = value as SaveAutomationTemplate;
                                    setSaveAutomationTemplate(nextTemplate);
                                    if (nextTemplate === "flutter_hot_reload") {
                                      setSaveAutomationFilePatternsText(FLUTTER_HOT_RELOAD_PATTERN);
                                      setSaveAutomationPayload(FLUTTER_HOT_RELOAD_PAYLOAD);
                                    }
                                    setDirty(true);
                                  }}
                                  className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                                  itemClassName="text-[13px]"
                                  options={[
                                    { value: "custom_generic", label: "No preset" },
                                    { value: "flutter_hot_reload", label: "Flutter hot reload" },
                                  ]}
                                />
                                <p className="text-[10px] leading-5 text-muted-foreground">
                                  Optional. Presets only fill the fields below.
                                </p>
                              </div>

                              <div className="space-y-1.5">
                                <label className="block text-[11px] font-medium text-foreground">Text To Send</label>
                                <input
                                  type="text"
                                  className={cn(SETTINGS_INPUT_CLASS_NAME, "font-mono")}
                                  placeholder="reload"
                                  value={saveAutomationPayload}
                                  onChange={(e) => {
                                    const nextValue = e.target.value;
                                    setSaveAutomationPayload(nextValue);
                                    setSaveAutomationTemplate(inferSaveAutomationTemplate({
                                      filePatternsText: saveAutomationFilePatternsText,
                                      payload: nextValue,
                                    }));
                                    setDirty(true);
                                  }}
                                />
                                <p className="text-[10px] leading-5 text-muted-foreground">
                                  Examples: `reload`, `rs`, or `r`. Sent to the active Run session first, then the workspace terminal.
                                </p>
                              </div>

                              <div className="space-y-1.5 md:col-span-2">
                                <label className="block text-[11px] font-medium text-foreground">File Patterns</label>
                                <textarea
                                  className={SETTINGS_TEXTAREA_CLASS_NAME}
                                  rows={3}
                                  placeholder={"lib/**/*.dart\nsrc/**/*.tsx"}
                                  value={saveAutomationFilePatternsText}
                                  onChange={(e) => {
                                    const nextValue = e.target.value;
                                    setSaveAutomationFilePatternsText(nextValue);
                                    setSaveAutomationTemplate(inferSaveAutomationTemplate({
                                      filePatternsText: nextValue,
                                      payload: saveAutomationPayload,
                                    }));
                                    setDirty(true);
                                  }}
                                />
                                <p className="text-[10px] leading-5 text-muted-foreground">
                                  One glob per line. Only matching saved files will trigger the action.
                                </p>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="text-[11px] leading-5 text-muted-foreground/80">
                            Example pairs: `src/**/*.tsx` + `rs`, or `lib/**/*.dart` + `r`.
                          </p>
                        )}
                      </SettingsSection>

                      <SettingsSection
                        title="Setup Scripts"
                        description="One command per line. Runs sequentially after worktree creation."
                        descriptionId="workspace-setup-scripts-description"
                      >
                        <textarea
                          aria-label="Setup Scripts"
                          className={SETTINGS_TEXTAREA_CLASS_NAME}
                          rows={5}
                          placeholder={"bun install\ncp .env.example .env"}
                          value={setupText}
                          onChange={(e) => { setSetupText(e.target.value); setDirty(true); }}
                        />
                      </SettingsSection>

                      <SettingsSection
                        title="Teardown Scripts"
                        description="One command per line. Runs sequentially before worktree deletion."
                        descriptionId="workspace-teardown-scripts-description"
                      >
                        <textarea
                          aria-label="Teardown Scripts"
                          className={SETTINGS_TEXTAREA_CLASS_NAME}
                          rows={5}
                          placeholder="docker-compose down"
                          value={teardownText}
                          onChange={(e) => { setTeardownText(e.target.value); setDirty(true); }}
                        />
                      </SettingsSection>
                    </div>

                    <div className="flex items-center justify-between border-t border-border/30 pt-4">
                      {selectedRepo ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setShowRemoveDialog(true)}
                        >
                          Remove Repository
                        </Button>
                      ) : <div />}

                      <div className="flex h-5 items-center text-xs text-muted-foreground">
                        {saving ? (
                          <span className="flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Saving
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-dashed border-border/40 bg-secondary/10">
                    <p className="text-sm text-muted-foreground">No repositories available</p>
                  </div>
                )}
              </div>
            ) : activeTab === "agents" ? (
              <AgentsSettingsPanel />
            ) : activeTab === "models" ? (
              <div className="space-y-5">
                <div className="hidden md:block">
                  <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">Models</h1>
                  <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
                    Choose default agents for common flows and manage custom provider entries used by the app.
                  </p>
                </div>

                {loadingModels ? (
                  <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-dashed border-border/40 bg-secondary/10">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading...
                    </div>
                  </div>
                ) : (
                  <div className="space-y-0">
                    <SettingsSection
                      title="Default Agent"
                      description="Saved default CLI agent and model selections for each flow."
                      descriptionId="models-default-agent-description"
                    >
                      <div className="space-y-0">
                        {([
                          ["newChat", "Agent for new chats", "Default agent for newly created chat threads."],
                          ["commit", "Agent for commit", "Used when generating commit-related flows."],
                          ["pullRequest", "Agent for PR", "Used when starting PR or MR review flows."],
                        ] as const).map(([key, label, description]) => {
                          const selection = resolvedAgentDefaults[key];
                          const options = visibleAgentModelOptions[key];

                          return (
                            <div
                              key={key}
                              className="border-t border-border/30 py-4 first:border-t-0 first:pt-0 last:pb-0"
                            >
                              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                                <div className="min-w-0 xl:max-w-sm">
                                  <h3 className="text-[13px] font-medium text-foreground">{label}</h3>
                                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                                    {description}
                                  </p>
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2 xl:w-[440px] xl:shrink-0">
                                  <SettingsSelect
                                    ariaLabel={`${label} CLI Agent`}
                                    value={selection.agent}
                                    onValueChange={(value) => {
                                      const nextAgent = value as CliAgent;
                                      const nextOptions = agentModelOptions[nextAgent];
                                      const fallbackOption = nextOptions[0];

                                      updateAgentDefault(key, () => ({
                                        agent: nextAgent,
                                        model: fallbackOption?.model ?? resolveAgentDefaultModel(nextAgent),
                                        modelProviderId: fallbackOption?.modelProviderId ?? null,
                                      }));
                                    }}
                                    className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                                    itemClassName="text-[13px]"
                                    options={[
                                      { value: "claude", label: "Claude" },
                                      { value: "codex", label: "Codex" },
                                      { value: "cursor", label: "Cursor" },
                                      { value: "opencode", label: "OpenCode" },
                                    ]}
                                  />
                                  <SettingsSelect
                                    ariaLabel={`${label} model`}
                                    value={`${selection.modelProviderId ?? "builtin"}::${selection.model}`}
                                    onValueChange={(value) => {
                                      const nextOption = options.find(
                                        (option) => `${option.modelProviderId ?? "builtin"}::${option.model}` === value,
                                      );
                                      if (!nextOption) {
                                        return;
                                      }

                                      updateAgentDefault(key, (current) => ({
                                        ...current,
                                        model: nextOption.model,
                                        modelProviderId: nextOption.modelProviderId,
                                      }));
                                    }}
                                    visualVariant="model-detail"
                                    className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                                    itemClassName="text-[13px]"
                                    options={options.map((option) => ({
                                      value: `${option.modelProviderId ?? "builtin"}::${option.model}`,
                                      label: option.label,
                                      detail: option.detail,
                                      source: option.source,
                                    }))}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </SettingsSection>

                    <SettingsSection
                      title="Model Providers"
                      description="Add compatibility-based model providers and keep them available everywhere the matching agents are supported."
                      descriptionId="models-providers-description"
                      action={(
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1.5 px-3 text-[13px]"
                          onClick={() => {
                            resetProviderForm("anthropic");
                            setShowProviderDialog(true);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add
                        </Button>
                      )}
                      actionClassName="md:w-auto md:max-w-none"
                    >
                      {providers.length === 0 ? (
                        <p className="text-[11px] leading-5 text-muted-foreground">
                          No compatibility-based providers configured yet. Add OpenAI or Anthropic entries here.
                        </p>
                      ) : (
                        <div className="space-y-5">
                          {PROVIDER_COMPATIBILITY_ORDER.map((compatibility) => {
                            const groupProviders = providers.filter(
                              (provider) => (provider.compatibility ?? "anthropic") === compatibility,
                            );
                            if (groupProviders.length === 0) {
                              return null;
                            }

                            return (
                              <div key={compatibility} className="space-y-2">
                                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                  {getProviderCompatibilityLabel(compatibility)}-compatible
                                </p>
                                <div className="overflow-hidden rounded-xl border border-border/60 bg-background/20">
                                  {groupProviders.map((provider, index) => {
                                    const providerModels = provider.models ?? [];
                                    const expanded = expandedProviderIds.has(provider.id);

                                    return (
                                      <div
                                        key={provider.id}
                                        className={cn(
                                          "group/provider",
                                          index > 0 ? "border-t border-border/40" : null,
                                        )}
                                      >
                                        <div className="flex items-center gap-2 px-3 py-2.5">
                                          <button
                                            type="button"
                                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                            aria-expanded={expanded}
                                            aria-label={`${expanded ? "Collapse" : "Expand"} provider ${provider.name}`}
                                            onClick={() => toggleProviderExpanded(provider.id)}
                                          >
                                            <ChevronDown
                                              className={cn(
                                                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                                                expanded ? null : "-rotate-90",
                                              )}
                                            />
                                            <span className="truncate text-[13px] font-medium text-foreground">
                                              {provider.name}
                                            </span>
                                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                                              {providerModels.length} model{providerModels.length === 1 ? "" : "s"}
                                            </Badge>
                                          </button>
                                          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/provider:opacity-100 focus-within:opacity-100">
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="icon"
                                              className="h-7 w-7 text-muted-foreground"
                                              aria-label={`Edit provider ${provider.name}`}
                                              title={`Edit ${provider.name}`}
                                              onClick={() => handleEditProvider(provider)}
                                            >
                                              <Pencil className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="icon"
                                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                              aria-label={`Delete provider ${provider.name}`}
                                              title={`Delete ${provider.name}`}
                                              onClick={() => void handleDeleteProvider(provider.id)}
                                            >
                                              <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                          </div>
                                        </div>

                                        {expanded ? (
                                          <div className="space-y-4 px-3 pb-4 pl-9">
                                            <div className="space-y-1 text-[11px] leading-5 text-muted-foreground">
                                              <div>Works with: {formatSupportedAgentsForCompatibility(provider.compatibility)}</div>
                                              <div className="break-all">Endpoint: {provider.baseUrl || "Not stored"}</div>
                                              <div>
                                                API Key:{" "}
                                                {provider.apiKeyMasked
                                                  ? <span className="font-mono">{provider.apiKeyMasked}</span>
                                                  : "Not stored"}
                                              </div>
                                            </div>

                                            <div className="space-y-2">
                                              <p className="text-[11px] font-medium text-muted-foreground">Models</p>
                                              <div className="flex flex-wrap items-center gap-2">
                                                {providerModels.map((model) => {
                                                  const status = modelTestStatus[model.id];
                                                  return (
                                                    <Badge
                                                      key={model.id}
                                                      variant="secondary"
                                                      className="group/model max-w-full gap-1 pr-1 font-mono text-[11px] font-normal"
                                                      title={status?.state === "error" ? status.error : undefined}
                                                    >
                                                      <span className="max-w-[220px] truncate">{model.modelId}</span>
                                                      {status?.state === "success" ? (
                                                        <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                                                      ) : status?.state === "error" ? (
                                                        <CircleAlert className="h-3 w-3 shrink-0 text-destructive" />
                                                      ) : null}
                                                      {status?.state === "testing" ? (
                                                        <span className="p-0.5" aria-label={`Testing model ${model.modelId}`}>
                                                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                                                        </span>
                                                      ) : (
                                                        <button
                                                          type="button"
                                                          className={cn(
                                                            "rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground",
                                                            "opacity-0 group-hover/model:opacity-100 focus-visible:opacity-100",
                                                          )}
                                                          aria-label={`Test model ${model.modelId}`}
                                                          title={`Test ${model.modelId}`}
                                                          onClick={() => void handleTestProviderModel(provider.id, model.id, model.modelId)}
                                                        >
                                                          <Play className="h-3 w-3" />
                                                        </button>
                                                      )}
                                                      <button
                                                        type="button"
                                                        className="rounded-full p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover/model:opacity-100"
                                                        aria-label={`Delete model ${model.modelId}`}
                                                        title={`Delete ${model.modelId}`}
                                                        onClick={() => void handleDeleteProviderModel(provider, model.id)}
                                                      >
                                                        <X className="h-3 w-3" />
                                                      </button>
                                                    </Badge>
                                                  );
                                                })}
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="sm"
                                                  className="h-7 gap-1 border-dashed px-2.5 text-[11px]"
                                                  onClick={() => openAddModelDialog(provider)}
                                                >
                                                  <Plus className="h-3 w-3" />
                                                  Add model
                                                </Button>
                                              </div>
                                            </div>
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                        {providerFootnote}
                      </p>

                      <Dialog
                        open={addModelDialogProvider !== null}
                        onOpenChange={(nextOpen) => {
                          if (!nextOpen) {
                            closeAddModelDialog();
                          }
                        }}
                      >
                        <DialogContent className="sm:max-w-[440px]">
                          <DialogHeader>
                            <DialogTitle>Add model</DialogTitle>
                            <DialogDescription>
                              {addModelDialogProvider
                                ? `Add a model ID for ${addModelDialogProvider.name}.`
                                : "Add a model ID to this provider."}
                            </DialogDescription>
                          </DialogHeader>

                          <div className="space-y-2">
                            <label className="text-[11px] font-medium text-foreground" htmlFor="provider-add-model-id">
                              Model ID
                            </label>
                            <Input
                              id="provider-add-model-id"
                              aria-label="Model ID"
                              type="text"
                              placeholder='e.g. "claude-sonnet-4-6", "gpt-5.4"'
                              value={addModelId}
                              onChange={(event) => {
                                setAddModelId(event.target.value);
                                setAddModelError(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && !savingAddModel) {
                                  event.preventDefault();
                                  void handleAddProviderModel();
                                }
                              }}
                              autoFocus
                            />
                            {addModelError ? (
                              <p className="text-[11px] leading-5 text-destructive">{addModelError}</p>
                            ) : null}
                          </div>

                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-8 text-[13px]"
                              disabled={savingAddModel}
                              onClick={closeAddModelDialog}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              className="h-8 gap-1.5 text-[13px]"
                              disabled={savingAddModel || addModelId.trim().length === 0}
                              onClick={() => void handleAddProviderModel()}
                            >
                              {savingAddModel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                              Add model
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>

                      <Dialog
                        open={showProviderDialog}
                        onOpenChange={(nextOpen) => {
                          if (!nextOpen) {
                            resetProviderForm(providerCompatibility);
                            return;
                          }

                          setShowProviderDialog(true);
                        }}
                      >
                        <DialogContent className="sm:max-w-[560px]">
                          <DialogHeader>
                            <DialogTitle>{editingProviderId ? "Edit Provider" : "Add Provider"}</DialogTitle>
                            <DialogDescription>
                              {editingProviderId
                                ? "Update this provider endpoint. Models stay under this provider."
                                : "Create one provider endpoint with one initial model."}
                            </DialogDescription>
                          </DialogHeader>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-1.5">
                              <label className="block text-[11px] font-medium text-foreground">Provider Compatibility</label>
                              <SettingsSelect
                                ariaLabel="Provider Compatibility"
                                value={providerCompatibility}
                                onValueChange={(value) => {
                                  setProviderCompatibility(value as ModelProviderCompatibility);
                                  setTestResult(null);
                                  setProviderFormError(null);
                                }}
                                className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                                itemClassName="text-[13px]"
                                options={[
                                  { value: "openai", label: "OpenAI" },
                                  { value: "anthropic", label: "Anthropic" },
                                ]}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="block text-[11px] font-medium text-foreground">Provider Name</label>
                              <input
                                aria-label="Provider Name"
                                type="text"
                                className={SETTINGS_INPUT_CLASS_NAME}
                                placeholder='e.g. "OpenAI", "OpenRouter", "Anthropic Proxy"'
                                value={providerName}
                                onChange={(e) => {
                                  setProviderName(e.target.value);
                                  setTestResult(null);
                                  setProviderFormError(null);
                                }}
                              />
                            </div>
                            {editingProviderId ? null : (
                              <div className="space-y-1.5">
                                <label className="block text-[11px] font-medium text-foreground">Initial Model ID</label>
                                <input
                                  aria-label="Initial Model ID"
                                  type="text"
                                  className={SETTINGS_INPUT_CLASS_NAME}
                                  placeholder={providerModelPlaceholder}
                                  value={providerModelId}
                                  onChange={(e) => {
                                    setProviderModelId(e.target.value);
                                    setTestResult(null);
                                    setProviderFormError(null);
                                  }}
                                />
                              </div>
                            )}
                            <div className="space-y-1.5">
                              <label className="block text-[11px] font-medium text-foreground">Provider Base URL</label>
                              <input
                                aria-label="Provider Base URL"
                                type="url"
                                aria-invalid={providerBaseUrlError ? "true" : "false"}
                                className={SETTINGS_INPUT_CLASS_NAME}
                                placeholder={providerBaseUrlPlaceholder}
                                value={providerBaseUrl}
                                onChange={(e) => {
                                  setProviderBaseUrl(e.target.value);
                                  setTestResult(null);
                                  setProviderFormError(null);
                                }}
                              />
                              {providerBaseUrlError ? (
                                <p className="text-[11px] leading-5 text-destructive">{providerBaseUrlError}</p>
                              ) : null}
                            </div>
                            <div className="space-y-1.5 md:col-span-2">
                              <label className="block text-[11px] font-medium text-foreground">Provider API Key</label>
                              <input
                                aria-label="Provider API Key"
                                type="password"
                                className={SETTINGS_INPUT_CLASS_NAME}
                                placeholder={providerApiKeyPlaceholder}
                                value={providerApiKey}
                                onChange={(e) => {
                                  setProviderApiKey(e.target.value);
                                  setTestResult(null);
                                  setProviderFormError(null);
                                }}
                              />
                            </div>
                          </div>

                          <p className="text-[11px] leading-5 text-muted-foreground">
                            {providerInlineHelp}
                          </p>
                          <p className="text-[11px] leading-5 text-muted-foreground">
                            Works with {formatSupportedAgentsForCompatibility(providerCompatibility)}.
                          </p>

                          {testResult ? (
                            <div className={`rounded-lg px-3 py-2 text-[13px] ${testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-destructive/10 text-destructive"}`}>
                              {testResult.success ? providerTestSuccessMessage : testResult.error}
                            </div>
                          ) : null}
                          {providerFormError ? (
                            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                              {providerFormError}
                            </div>
                          ) : null}

                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-[13px]"
                              onClick={() => resetProviderForm(providerCompatibility)}
                            >
                              Cancel
                            </Button>
                            {editingProviderId ? null : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-[13px]"
                                disabled={!canTestProvider || testingProvider}
                                onClick={() => void handleTestProvider()}
                              >
                                {testingProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              className="h-8 text-[13px]"
                              disabled={!canSaveProvider || savingProvider}
                              onClick={() => void handleSaveProvider()}
                            >
                              {savingProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </SettingsSection>
                  </div>
                )}
              </div>
            ) : activeTab === "shortcuts" ? (
              <div className="space-y-6">
                <div className="hidden items-start justify-between gap-4 md:flex">
                  <div>
                    <h1 className="text-xl font-semibold text-foreground">Keyboard shortcuts</h1>
                    <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
                      Shortcuts available in the current workspace.
                    </p>
                  </div>
                </div>

                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="text"
                    value={shortcutSearchQuery}
                    onChange={(event) => setShortcutSearchQuery(event.target.value)}
                    placeholder="Search"
                    aria-label="Search shortcuts"
                    className="border-transparent bg-secondary/40 pl-9 shadow-none focus-visible:ring-1"
                  />
                </div>

                <div className="space-y-6">
                  {filteredShortcutSections.map((section) => (
                    <section key={section.id}>
                      <h2 className="mb-2 text-sm font-medium text-muted-foreground">{section.label}</h2>
                      <div className="overflow-hidden rounded-lg border border-border/60 bg-background divide-y divide-border/60">
                        {section.shortcuts.map((shortcut) => {
                          const label = getWorkspaceShortcutLabel(shortcut, shortcutPlatform);
                          if (!label) {
                            return null;
                          }

                          return (
                            <div
                              key={shortcut.id}
                              className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-secondary/20"
                            >
                              <div className="min-w-0">
                                <div className="text-sm text-foreground">{shortcut.label}</div>
                                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                                  {shortcut.description}
                                </div>
                              </div>
                              <code className="shrink-0 rounded-md border border-border/60 bg-secondary/30 px-2 py-1 text-[11px] font-medium text-foreground">
                                {label}
                              </code>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}

                  {filteredShortcutSections.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      No shortcuts found matching "{shortcutSearchQuery}".
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="hidden md:block">
                  <h2 className="text-sm font-semibold text-foreground">Open Source Licenses</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Third-party assets bundled in the app should keep their original license and attribution notice.
                  </p>
                </div>

                <div className="space-y-3">
                  {THIRD_PARTY_LICENSES.map((entry) => (
                    <section
                      key={entry.id}
                      className="rounded-xl border border-border/40 bg-secondary/10 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-medium text-foreground">{entry.name}</h3>
                          <p className="mt-1 text-[11px] text-muted-foreground">{entry.copyright}</p>
                        </div>
                        <span className="shrink-0 rounded-full border border-border/50 bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {entry.license}
                        </span>
                      </div>

                      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                        <div>
                          Source:{" "}
                          <a
                            href={entry.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-foreground underline underline-offset-2"
                          >
                            {entry.sourceUrl}
                          </a>
                        </div>
                        {entry.assetPath ? (
                          <div>
                            Bundled notice:{" "}
                            <code className="rounded bg-secondary/60 px-1 py-0.5 text-[11px]">{entry.assetPath}</code>
                          </div>
                        ) : null}
                      </div>

                      <pre className="mt-3 overflow-x-auto rounded-lg border border-border/40 bg-background/80 p-3 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
                        {entry.text}
                      </pre>
                    </section>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Remove confirmation dialog */}
      {selectedRepo && (
        <Dialog open={showRemoveDialog} onOpenChange={(isOpen) => { if (!isOpen) setShowRemoveDialog(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Remove {selectedRepo.name}?</DialogTitle>
              <DialogDescription>
                All workspaces will be permanently deleted. The source directory{" "}
                <code className="rounded bg-secondary/60 px-1 py-0.5 text-[11px]">{selectedRepo.rootPath}</code>{" "}
                will not be modified.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowRemoveDialog(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setShowRemoveDialog(false);
                  onRemoveRepository(selectedRepo.id);
                }}
              >
                Remove
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
