import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { api } from "../../lib/api";
import { isTauriDesktop } from "../../lib/openExternalUrl";
import { queryKeys } from "../../lib/queryKeys";
import { THIRD_PARTY_LICENSES } from "../../lib/thirdPartyLicenses";
import { cn } from "../../lib/utils";
import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  type CliAgent,
  type CodexModelCatalogEntry,
  type ModelProvider,
  type Repository,
  type SaveAutomationConfig,
} from "@codesymphony/shared-types";
import {
  FALLBACK_CODEX_MODELS,
  resolveAgentDefaultModel,
} from "../../lib/agentModelDefaults";
import { useModelProviders } from "../../pages/workspace/hooks/useModelProviders";
import {
  loadAgentDefaults,
  saveAgentDefaults,
  type AgentDefaults,
  type AgentDefaultSelection,
} from "../../pages/workspace/agentDefaults";
import {
  getModifierEnterHint,
  getModifierEnterLabel,
  getShiftEnterHint,
  type GeneralSettings,
} from "../../lib/generalSettings";
import { COMPLETION_SOUND_OPTIONS, playCompletionSound } from "../../lib/completionSounds";

type SettingsTab = "general" | "workspace" | "models" | "licenses";
type SaveAutomationTemplate = "custom_generic" | "flutter_hot_reload";

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

type ProviderProtocol = "anthropic" | "responses";

const PROVIDER_PROTOCOL_BY_AGENT: Record<CliAgent, ProviderProtocol> = {
  claude: "anthropic",
  codex: "responses",
  cursor: "responses",
  opencode: "responses",
};

const PROVIDER_AGENT_LABELS: Record<CliAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

type AgentDefaultsKey = keyof AgentDefaults;

type AgentModelOption = {
  key: string;
  model: string;
  modelProviderId: string | null;
  label: string;
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
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p id={descriptionId} className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
          {hint ? (
            <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground/80">{hint}</p>
          ) : null}
        </div>
        <div className="shrink-0">{control}</div>
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
}: SettingsSelectProps) {
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
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className={cn("text-xs", itemClassName)}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function getProviderProtocol(agent: CliAgent | undefined | null): ProviderProtocol {
  return PROVIDER_PROTOCOL_BY_AGENT[agent ?? "claude"];
}

function getProviderAgentLabel(agent: CliAgent | undefined | null): string {
  return PROVIDER_AGENT_LABELS[agent ?? "claude"];
}

function formatAgentModelLabel(agent: CliAgent, model: string): string {
  if (agent === "cursor" && model === "default[]") {
    return "Auto";
  }

  if (agent === "opencode") {
    return model;
  }

  return model.replace(/\[[^\]]*]$/, "");
}

function buildAgentModelOptions(agent: CliAgent, providers: ModelProvider[]): AgentModelOption[] {
  const builtins = agent === "codex"
    ? []
    : BUILTIN_CHAT_MODELS_BY_AGENT[agent].map((model) => ({
      key: `${agent}:${model}:builtin`,
      model,
      modelProviderId: null,
      label: formatAgentModelLabel(agent, model),
    }));
  const custom = providers
    .filter((provider) => provider.agent === agent)
    .map((provider) => ({
      key: provider.id,
      model: provider.modelId,
      modelProviderId: provider.id,
      label: `${provider.modelId} · ${provider.name}`,
    }));

  return [...builtins, ...custom];
}

function buildCodexAgentModelOptions(
  providers: ModelProvider[],
  codexModels: readonly CodexModelCatalogEntry[],
): AgentModelOption[] {
  const builtins = (codexModels.length > 0
    ? codexModels.map((entry) => ({
      key: `codex:${entry.id}:builtin`,
      model: entry.id,
      modelProviderId: null,
      label: entry.name.trim() || formatAgentModelLabel("codex", entry.id),
    }))
    : FALLBACK_CODEX_MODELS.map((entry) => ({
      key: `codex:${entry.id}:builtin`,
      model: entry.id,
      modelProviderId: null,
      label: entry.name.trim() || formatAgentModelLabel("codex", entry.id),
    })));
  const custom = providers
    .filter((provider) => provider.agent === "codex")
    .map((provider) => ({
      key: provider.id,
      model: provider.modelId,
      modelProviderId: provider.id,
      label: `${provider.modelId} · ${provider.name}`,
    }));

  return [...builtins, ...custom];
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

  if (selection.agent === "codex" && selection.modelProviderId === null && selection.model.trim().length > 0) {
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

function isOpencodeBuiltinAlias(modelId: string): boolean {
  return /^[^/\s]+\/[^/\s].+$/.test(modelId.trim());
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
  codexModels: readonly CodexModelCatalogEntry[];
  generalSettings: GeneralSettings;
  runtimeLabel?: string | null;
  runtimeTitle?: string | null;
  onRemoveRepository: (id: string) => void;
  onGeneralSettingsChange: (next: GeneralSettings) => void;
  onProvidersChanged?: (providers: ModelProvider[]) => void;
}

function isMacDesktopShell(): boolean {
  if (!isTauriDesktop() || typeof navigator === "undefined") {
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

export function SettingsDialog({
  open,
  onClose,
  repositories,
  selectedRepositoryId,
  codexModels,
  generalSettings,
  runtimeLabel,
  runtimeTitle,
  onRemoveRepository,
  onGeneralSettingsChange,
  onProvidersChanged,
}: SettingsDialogProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [desktopNotificationsMessage, setDesktopNotificationsMessage] = useState<string | null>(null);
  const [testingCompletionSound, setTestingCompletionSound] = useState(false);

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
    loading: loadingModels,
    refreshProviders,
    replaceProviders,
  } = useModelProviders();

  // Provider form state
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerAgent, setProviderAgent] = useState<CliAgent>("claude");
  const [providerName, setProviderName] = useState("");
  const [providerModelId, setProviderModelId] = useState("");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>(() => loadAgentDefaults());
  const providerProtocol = getProviderProtocol(providerAgent);
  const trimmedProviderName = providerName.trim();
  const trimmedProviderModelId = providerModelId.trim();
  const trimmedProviderBaseUrl = providerBaseUrl.trim();
  const trimmedProviderApiKey = providerApiKey.trim();
  const providerUsesCustomEndpoint = trimmedProviderBaseUrl.length > 0 || trimmedProviderApiKey.length > 0;
  const opencodeUsesBuiltinAlias = providerAgent === "opencode"
    && trimmedProviderBaseUrl.length === 0
    && trimmedProviderApiKey.length === 0
    && isOpencodeBuiltinAlias(trimmedProviderModelId);
  const canSaveProvider = trimmedProviderName.length > 0
    && trimmedProviderModelId.length > 0
    && providerAgent !== "cursor"
    && (
      providerAgent === "codex"
      || (providerAgent === "opencode"
        ? trimmedProviderBaseUrl.length > 0 || opencodeUsesBuiltinAlias
        : !providerUsesCustomEndpoint
          || (trimmedProviderBaseUrl.length > 0 && (editingProviderId !== null || trimmedProviderApiKey.length > 0)))
    );
  const canTestProvider = providerAgent !== "cursor"
    && trimmedProviderBaseUrl.length > 0
    && trimmedProviderApiKey.length > 0
    && trimmedProviderModelId.length > 0;
  const providerModelPlaceholder = providerAgent === "claude"
    ? 'e.g. "claude-sonnet-4-6", "glm-4.7"'
    : providerAgent === "codex"
      ? 'e.g. "gpt-5.4", "gpt-5.3-codex"'
      : providerAgent === "cursor"
        ? "Cursor built-in models are managed via Cursor account settings"
      : 'e.g. "openai/gpt-5" or "gpt-5-custom"';
  const providerBaseUrlPlaceholder = providerAgent === "claude"
    ? "e.g. https://api.z.ai/v1"
    : providerAgent === "codex"
      ? "Leave empty to use Codex CLI defaults"
      : providerAgent === "cursor"
        ? "Cursor custom endpoints are not supported"
      : "Leave empty when Model ID already uses provider/model";
  const providerApiKeyPlaceholder = editingProviderId
    ? "Leave empty to keep current"
    : providerAgent === "claude"
      ? "API Key"
      : providerAgent === "codex"
        ? "Only if your Codex setup needs it"
        : providerAgent === "cursor"
          ? "Cursor custom endpoints are not supported"
        : "Only for custom OpenCode endpoints";
  const providerInlineHelp = providerAgent === "claude"
    ? "Use an empty Base URL and API key to register a Claude-side model alias that relies on local CLI auth. Provide both when targeting an Anthropic-compatible remote endpoint."
    : providerAgent === "codex"
      ? "Responses-compatible entries can be simple model aliases like gpt-5.4 or point to a custom endpoint if your Codex CLI setup needs it."
      : providerAgent === "cursor"
        ? "Cursor models come from the authenticated Cursor account over ACP. CodeSymphony does not register custom Cursor providers or custom endpoints."
      : "For built-in OpenCode providers, enter Model ID as provider/model, for example openai/gpt-5. If you provide a Base URL, the runtime registers a custom Responses-compatible provider for the OpenCode SDK.";
  const providerFootnote = providerAgent === "claude"
    ? "Add Anthropic-compatible model entries here, then choose them per thread under Claude in the composer. Endpoint tests validate Anthropic Messages API compatible backends."
    : providerAgent === "codex"
      ? "Add Responses-compatible model entries here, then choose them per thread under Codex in the composer. Endpoint tests validate OpenAI Responses API compatible backends before the Codex CLI runtime starts."
      : providerAgent === "cursor"
        ? "Cursor uses built-in models discovered from the authenticated Cursor CLI. No custom provider rows or endpoint tests are available for Cursor."
      : "Add OpenCode aliases or custom Responses-compatible providers here, then choose them per thread under OpenCode in the composer. Built-in OpenCode auth and /connect flows still work even if you never add an entry here.";
  const providerTestSuccessMessage = providerProtocol === "anthropic"
    ? "Connection successful — provider is Anthropic-compatible."
    : providerAgent === "opencode"
      ? "Connection successful — provider is Responses API compatible for OpenCode."
      : "Connection successful — provider is Responses API compatible.";
  const agentModelOptions = useMemo<Record<CliAgent, AgentModelOption[]>>(() => ({
    claude: buildAgentModelOptions("claude", providers),
    codex: buildCodexAgentModelOptions(providers, codexModels),
    cursor: buildAgentModelOptions("cursor", providers),
    opencode: buildAgentModelOptions("opencode", providers),
  }), [codexModels, providers]);

  const resolvedAgentDefaults = useMemo<AgentDefaults>(() => ({
    newChat: normalizeAgentDefaultSelection(agentDefaults.newChat, agentModelOptions[agentDefaults.newChat.agent]),
    commit: normalizeAgentDefaultSelection(agentDefaults.commit, agentModelOptions[agentDefaults.commit.agent]),
    pullRequest: normalizeAgentDefaultSelection(agentDefaults.pullRequest, agentModelOptions[agentDefaults.pullRequest.agent]),
  }), [agentDefaults, agentModelOptions]);

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

    setSelectedRepoId(resolveInitialRepositoryId(repositories, selectedRepositoryId));
  }, [open, repositories, selectedRepoId, selectedRepositoryId]);

  // ── Workspace: Load scripts ──
  useEffect(() => {
    if (!open || !selectedRepoId) return;

    const repo = repositories.find((candidate) => candidate.id === selectedRepoId);
    if (!repo) return;

    const repoChanged = hydratedRepoIdRef.current !== selectedRepoId;
    if (!repoChanged && dirty) {
      return;
    }

    const nextState = buildRepositoryFormState(repo, savedScriptsRef.current[selectedRepoId]);
    setRunScriptText(nextState.runScriptText);
    setSetupText(nextState.setupText);
    setTeardownText(nextState.teardownText);
    setDefaultBranchValue(nextState.defaultBranchValue);
    setSaveAutomationEnabled(nextState.saveAutomationEnabled);
    setSaveAutomationTemplate(nextState.saveAutomationTemplate);
    setSaveAutomationFilePatternsText(nextState.saveAutomationFilePatternsText);
    setSaveAutomationPayload(nextState.saveAutomationPayload);
    hydratedRepoIdRef.current = selectedRepoId;
    setDirty(false);
    setShowRemoveDialog(false);
  }, [dirty, open, repositories, selectedRepoId]);

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
    onProvidersChanged?.(providers);
  }, [onProvidersChanged, providers]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setAgentDefaults(loadAgentDefaults());
  }, [open]);

  useEffect(() => {
    if (!open || typeof Notification === "undefined") {
      return;
    }

    if (generalSettings.desktopNotificationsEnabled && Notification.permission === "denied") {
      setDesktopNotificationsMessage("Desktop notifications are blocked by the browser for this app.");
      return;
    }

    setDesktopNotificationsMessage(null);
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

  const resetProviderForm = useCallback((nextAgent: CliAgent = "claude") => {
    setEditingProviderId(null);
    setProviderAgent(nextAgent);
    setProviderName("");
    setProviderModelId("");
    setProviderBaseUrl("");
    setProviderApiKey("");
    setShowProviderForm(false);
    setTestResult(null);
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

  // Auto-save effect
  useEffect(() => {
    if (!dirty) return;
    const timeoutId = setTimeout(() => { void handleSave(); }, 1000);
    return () => clearTimeout(timeoutId);
  }, [dirty, handleSave]);

  const handleSaveProvider = useCallback(async () => {
    if (!canSaveProvider) return;
    setSavingProvider(true);
    try {
      let nextProvider: ModelProvider;
      if (editingProviderId) {
        nextProvider = await api.updateModelProvider(editingProviderId, {
          agent: providerAgent,
          name: trimmedProviderName,
          modelId: trimmedProviderModelId,
          baseUrl: trimmedProviderBaseUrl || null,
          ...(trimmedProviderApiKey ? { apiKey: trimmedProviderApiKey } : trimmedProviderBaseUrl.length === 0 ? { apiKey: null } : {}),
        });
      } else {
        nextProvider = await api.createModelProvider({
          agent: providerAgent,
          name: trimmedProviderName,
          modelId: trimmedProviderModelId,
          ...(trimmedProviderBaseUrl ? { baseUrl: trimmedProviderBaseUrl } : {}),
          ...(trimmedProviderApiKey ? { apiKey: trimmedProviderApiKey } : {}),
        });
      }
      resetProviderForm(providerAgent);
      replaceProviders([
        ...providers.filter((provider) => provider.id !== nextProvider.id),
        nextProvider,
      ]);
    } catch {
      // non-critical
    } finally {
      setSavingProvider(false);
    }
  }, [
    canSaveProvider,
    editingProviderId,
    providerAgent,
    providers,
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

  const handleEditProvider = useCallback((provider: ModelProvider) => {
    setEditingProviderId(provider.id);
    setProviderAgent(provider.agent ?? "claude");
    setProviderName(provider.name);
    setProviderModelId(provider.modelId);
    setProviderBaseUrl(provider.baseUrl ?? "");
    setProviderApiKey("");
    setShowProviderForm(true);
    setTestResult(null);
  }, []);

  const handleTestProvider = useCallback(async () => {
    if (!canTestProvider) return;
    setTestingProvider(true);
    setTestResult(null);
    try {
      const result = await api.testModelProvider({
        agent: providerAgent,
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
  }, [canTestProvider, providerAgent, trimmedProviderApiKey, trimmedProviderBaseUrl, trimmedProviderModelId]);

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

  const handleDesktopNotificationsToggle = useCallback(async (checked: boolean) => {
    if (!checked) {
      setDesktopNotificationsMessage(null);
      onGeneralSettingsChange({
        ...generalSettings,
        desktopNotificationsEnabled: false,
      });
      return;
    }

    if (typeof Notification === "undefined") {
      setDesktopNotificationsMessage("This browser does not support desktop notifications.");
      return;
    }

    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }

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

  const handleTestCompletionSound = useCallback(async () => {
    if (generalSettings.completionSound === "off") {
      return;
    }

    setTestingCompletionSound(true);
    try {
      await playCompletionSound(generalSettings.completionSound);
    } finally {
      setTestingCompletionSound(false);
    }
  }, [generalSettings.completionSound]);

  const selectedRepo = repositories.find((r) => r.id === selectedRepoId) ?? null;
  const macDesktopShell = isMacDesktopShell();
  const sendMessagesHint = generalSettings.sendMessagesWith === "enter"
    ? `Use ${getShiftEnterHint()} for new lines.`
    : `Use Enter for new lines. Send with ${getModifierEnterHint()}.`;
  const completionAttentionHint = "Completion alerts are suppressed when the finished chat is already visible and focused.";
  const primarySettingsTabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: "General" },
    { id: "workspace", label: "Workspace" },
    { id: "models", label: "Models" },
  ];
  const referenceSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "licenses", label: "Licenses" },
  ];

  if (!open) return null;

  return (
    <>
      {/* Full-page overlay */}
      <div className="fixed inset-0 z-50 flex overflow-hidden bg-background">
        {/* Left panel — sidebar style */}
        <aside
          className={`flex w-[232px] shrink-0 flex-col border-r border-border/30 bg-card/60 px-4 pb-4 ${
            macDesktopShell ? "pt-[46px]" : "pt-3"
          }`}
          data-testid="settings-sidebar"
        >
          <button
            type="button"
            className="mb-5 flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close settings"
            onClick={() => { void handleCloseSettings(); }}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm font-semibold text-foreground">Settings</span>
          </button>

          <div className="space-y-5">
            <div>
              <div className="mb-2 px-3 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/65">
                Preferences
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
                Reference
              </div>
              <div className="space-y-1">
                {referenceSettingsTabs.map((tab) => (
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

        {/* Right panel */}
        <div className="flex flex-1 flex-col overflow-y-auto p-4">
          {macDesktopShell ? <SettingsDesktopAppBar /> : null}

          <div className={`mx-auto w-full ${activeTab === "licenses" ? "max-w-4xl" : "max-w-5xl"}`}>
            {activeTab === "general" ? (
              <div className="space-y-5">
                <div>
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
                      <PreferenceToggle
                        checked={generalSettings.desktopNotificationsEnabled}
                        ariaLabel="Desktop notifications"
                        onCheckedChange={(checked) => {
                          void handleDesktopNotificationsToggle(checked);
                        }}
                      />
                    )}
                  />

                  <GeneralPreferenceRow
                    title="Completion sound"
                    description="Choose what plays when AI finishes working in a chat."
                    hint={completionAttentionHint}
                    descriptionId="general-completion-sound-description"
                    control={(
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
                          size="sm"
                          className="h-auto px-0 text-[13px]"
                          disabled={generalSettings.completionSound === "off" || testingCompletionSound}
                          onClick={() => {
                            void handleTestCompletionSound();
                          }}
                        >
                          Test
                        </Button>
                      </div>
                    )}
                  />

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
                </div>
              </div>
            ) : activeTab === "workspace" ? (
              <div className="space-y-5">
                <div>
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
            ) : activeTab === "models" ? (
              <div className="space-y-5">
                <div>
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
                          const options = agentModelOptions[selection.agent];

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
                                    className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                                    itemClassName="text-[13px]"
                                    options={options.map((option) => ({
                                      value: `${option.modelProviderId ?? "builtin"}::${option.model}`,
                                      label: option.label,
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
                      description="Add custom Claude, Codex, or OpenCode model endpoints and keep them available across the app."
                      descriptionId="models-providers-description"
                      action={(
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1.5 px-3 text-[13px]"
                          onClick={() => {
                            resetProviderForm("claude");
                            setShowProviderForm(true);
                          }}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add
                        </Button>
                      )}
                      actionClassName="md:w-auto md:max-w-none"
                    >
                      {providers.length === 0 && !showProviderForm ? (
                        <p className="text-[11px] leading-5 text-muted-foreground">
                          No custom models configured yet. Add Claude, Codex, or OpenCode entries here.
                          Claude uses Anthropic-compatible backends; Codex and OpenCode custom endpoints use the Responses API.
                        </p>
                      ) : null}

                      {providers.length > 0 ? (
                        <div className="space-y-0">
                          {providers.map((provider) => (
                            <div
                              key={provider.id}
                              className="border-t border-border/30 py-4 first:border-t-0 first:pt-0 last:pb-0"
                            >
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded-full border border-border/50 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                      {getProviderAgentLabel(provider.agent)}
                                    </span>
                                    <span className="text-[13px] font-medium text-foreground">{provider.name}</span>
                                    <span className="text-muted-foreground/50">·</span>
                                    <span className="font-mono text-[11px] text-muted-foreground">{provider.modelId}</span>
                                  </div>
                                  <div className="mt-2 space-y-1 text-[11px] leading-5 text-muted-foreground">
                                    <div>
                                      Endpoint:{" "}
                                      {provider.baseUrl ? (
                                        <span className="break-all">{provider.baseUrl}</span>
                                      ) : (
                                        <span>No endpoint override</span>
                                      )}
                                    </div>
                                    <div>
                                      API Key:{" "}
                                      {provider.apiKeyMasked ? (
                                        <span className="font-mono">{provider.apiKeyMasked}</span>
                                      ) : (
                                        <span>Not stored</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 self-start">
                                  <button
                                    type="button"
                                    className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                                    aria-label={`Edit ${getProviderAgentLabel(provider.agent)} provider ${provider.name} (${provider.modelId})`}
                                    title={`Edit ${provider.name}`}
                                    onClick={() => handleEditProvider(provider)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                    aria-label={`Delete ${getProviderAgentLabel(provider.agent)} provider ${provider.name} (${provider.modelId})`}
                                    title={`Delete ${provider.name}`}
                                    onClick={() => void handleDeleteProvider(provider.id)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {showProviderForm ? (
                        <div className="mt-3 border-t border-border/30 pt-4">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-semibold text-foreground">
                                {editingProviderId ? "Edit Provider" : "Add Provider"}
                              </h3>
                              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                                Configure a model alias, endpoint override, and optional API key for this CLI agent.
                              </p>
                            </div>
                            <button
                              type="button"
                              className="rounded-md p-1 text-muted-foreground hover:text-foreground"
                              onClick={() => resetProviderForm(providerAgent)}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-1.5">
                              <label className="block text-[11px] font-medium text-foreground">Agent</label>
                              <SettingsSelect
                                ariaLabel="Provider CLI Agent"
                                value={providerAgent}
                                onValueChange={(value) => {
                                  setProviderAgent(value as CliAgent);
                                  setTestResult(null);
                                }}
                                className="rounded-lg border-border/60 bg-background/20 px-3 text-[13px]"
                                itemClassName="text-[13px]"
                                options={[
                                  { value: "claude", label: "Claude" },
                                  { value: "codex", label: "Codex" },
                                  { value: "opencode", label: "OpenCode" },
                                ]}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="block text-[11px] font-medium text-foreground">Provider Name</label>
                              <input
                                aria-label="Provider Name"
                                type="text"
                                className={SETTINGS_INPUT_CLASS_NAME}
                                placeholder='e.g. "z.ai", "OpenRouter"'
                                value={providerName}
                                onChange={(e) => setProviderName(e.target.value)}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="block text-[11px] font-medium text-foreground">Model ID</label>
                              <input
                                aria-label="Provider Model ID"
                                type="text"
                                className={SETTINGS_INPUT_CLASS_NAME}
                                placeholder={providerModelPlaceholder}
                                value={providerModelId}
                                onChange={(e) => setProviderModelId(e.target.value)}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="block text-[11px] font-medium text-foreground">Base URL (optional)</label>
                              <input
                                aria-label="Provider Base URL"
                                type="text"
                                className={SETTINGS_INPUT_CLASS_NAME}
                                placeholder={providerBaseUrlPlaceholder}
                                value={providerBaseUrl}
                                onChange={(e) => setProviderBaseUrl(e.target.value)}
                              />
                            </div>
                            <div className="space-y-1.5 md:col-span-2">
                              <label className="block text-[11px] font-medium text-foreground">API Key (optional)</label>
                              <input
                                aria-label="Provider API Key"
                                type="password"
                                className={SETTINGS_INPUT_CLASS_NAME}
                                placeholder={providerApiKeyPlaceholder}
                                value={providerApiKey}
                                onChange={(e) => setProviderApiKey(e.target.value)}
                              />
                            </div>
                          </div>

                          <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                            {providerInlineHelp}
                          </p>

                          {testResult ? (
                            <div className={`mt-3 rounded-lg px-3 py-2 text-[13px] ${testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-destructive/10 text-destructive"}`}>
                              {testResult.success ? providerTestSuccessMessage : testResult.error}
                            </div>
                          ) : null}

                          <div className="mt-4 flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-[13px]"
                              onClick={() => resetProviderForm(providerAgent)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-[13px]"
                              disabled={!canTestProvider || testingProvider}
                              onClick={() => void handleTestProvider()}
                            >
                              {testingProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}
                            </Button>
                            <Button
                              size="sm"
                              className="h-8 text-[13px]"
                              disabled={!canSaveProvider || savingProvider}
                              onClick={() => void handleSaveProvider()}
                            >
                              {savingProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                        {providerFootnote}
                      </p>
                    </SettingsSection>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
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
