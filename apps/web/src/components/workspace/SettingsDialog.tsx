import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { THIRD_PARTY_LICENSES } from "../../lib/thirdPartyLicenses";
import type { CliAgent, ModelProvider, Repository } from "@codesymphony/shared-types";
import { useModelProviders } from "../../pages/workspace/hooks/useModelProviders";

type SettingsTab = "workspace" | "models" | "licenses";

type RepositoryFormState = {
  runScriptText: string;
  setupText: string;
  teardownText: string;
  defaultBranchValue: string;
};

type ApiCompatibility = "anthropic" | "openai";

const API_COMPATIBILITY_BY_AGENT: Record<CliAgent, ApiCompatibility> = {
  claude: "anthropic",
  codex: "openai",
};

const AGENT_BY_API_COMPATIBILITY: Record<ApiCompatibility, CliAgent> = {
  anthropic: "claude",
  openai: "codex",
};

const API_COMPATIBILITY_LABELS: Record<ApiCompatibility, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

function getProviderCompatibility(agent: CliAgent | undefined | null): ApiCompatibility {
  return API_COMPATIBILITY_BY_AGENT[agent ?? "claude"];
}

function getProviderCompatibilityLabel(agent: CliAgent | undefined | null): string {
  return API_COMPATIBILITY_LABELS[getProviderCompatibility(agent)];
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
  };
}

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  repositories: Repository[];
  onRemoveRepository: (id: string) => void;
  onProvidersChanged?: (providers: ModelProvider[]) => void;
}

export function SettingsDialog({ open, onClose, repositories, onRemoveRepository, onProvidersChanged }: SettingsDialogProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("workspace");

  // ── Workspace tab state ──
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [runScriptText, setRunScriptText] = useState("");
  const [setupText, setSetupText] = useState("");
  const [teardownText, setTeardownText] = useState("");
  const [defaultBranchValue, setDefaultBranchValue] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const savedScriptsRef = useRef<Record<string, RepositoryFormState>>({});
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const hydratedRepoIdRef = useRef<string | null>(null);
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
  const providerCompatibility = getProviderCompatibility(providerAgent);
  const trimmedProviderName = providerName.trim();
  const trimmedProviderModelId = providerModelId.trim();
  const trimmedProviderBaseUrl = providerBaseUrl.trim();
  const trimmedProviderApiKey = providerApiKey.trim();
  const providerUsesCustomEndpoint = trimmedProviderBaseUrl.length > 0 || trimmedProviderApiKey.length > 0;
  const canSaveProvider = trimmedProviderName.length > 0
    && trimmedProviderModelId.length > 0
    && (
      providerAgent === "codex"
      || !providerUsesCustomEndpoint
      || (trimmedProviderBaseUrl.length > 0 && (editingProviderId !== null || trimmedProviderApiKey.length > 0))
    );
  const canTestProvider = trimmedProviderBaseUrl.length > 0
    && trimmedProviderApiKey.length > 0
    && trimmedProviderModelId.length > 0;
  const providerModelPlaceholder = providerCompatibility === "anthropic"
    ? 'e.g. "claude-sonnet-4-6", "glm-4.7"'
    : 'e.g. "gpt-5.4", "gpt-5.3-codex"';
  const providerFootnote = providerCompatibility === "anthropic"
    ? "Add Anthropic-compatible model entries here, then choose them per thread under Claude in the composer. Endpoint tests validate Anthropic Messages API compatible backends."
    : "Add OpenAI-compatible model entries here, then choose them per thread under Codex in the composer. Endpoint tests validate OpenAI Responses API compatible backends before the Codex CLI runtime starts.";
  const providerTestSuccessMessage = providerCompatibility === "anthropic"
    ? "Connection successful — provider is Anthropic-compatible."
    : "Connection successful — provider is Responses API compatible.";

  // ── Workspace: Select first repo ──
  useEffect(() => {
    if (!open) {
      return;
    }

    hydratedRepoIdRef.current = null;
  }, [open]);

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

    setSelectedRepoId(repositories[0]?.id ?? null);
  }, [open, repositories, selectedRepoId]);

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
    const lines = scriptText.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
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
        const repo = repositories.find((r) => r.id === selectedRepoId);
        const branchChanged = repo && defaultBranchValue !== repo.defaultBranch;
        const updatedRepository = await api.updateRepositoryScripts(selectedRepoId, {
          runScript: runScriptLines,
          setupScript: setupLines,
          teardownScript: teardownLines,
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
  }, [defaultBranchValue, parseScriptLines, queryClient, repositories, runScriptText, selectedRepoId, setupText, teardownText]);

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

  const selectedRepo = repositories.find((r) => r.id === selectedRepoId) ?? null;

  if (!open) return null;

  return (
    <>
      {/* Full-page overlay */}
      <div className="fixed inset-0 z-50 flex bg-background p-1 sm:p-2 lg:p-3">
        {/* Left panel — sidebar style */}
        <aside className="flex w-[220px] shrink-0 flex-col rounded-2xl bg-card/75 p-3">
          <button
            type="button"
            className="mb-4 flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => { void handleCloseSettings(); }}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm font-semibold text-foreground">Settings</span>
          </button>

          <div className="space-y-0.5">
            <button
              type="button"
              className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
                activeTab === "workspace"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
              onClick={() => setActiveTab("workspace")}
            >
              Workspace
            </button>
            <button
              type="button"
              className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
                activeTab === "models"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
              onClick={() => setActiveTab("models")}
            >
              Models
            </button>
            <button
              type="button"
              className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${
                activeTab === "licenses"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
              onClick={() => setActiveTab("licenses")}
            >
              Licenses
            </button>
          </div>
        </aside>

        {/* Right panel */}
        <div className="flex flex-1 flex-col overflow-y-auto p-4">
          <div className="mx-auto w-full max-w-xl">
            {activeTab === "workspace" ? (
              <>
                {repositories.length > 0 ? (
                  <>
                    <div className="mb-4">
                      <label className="mb-1.5 block text-xs font-medium">Repository</label>
                      <select
                        className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                        value={selectedRepoId ?? ""}
                        onChange={(e) => setSelectedRepoId(e.target.value)}
                      >
                        {repositories.map((repo) => (
                          <option key={repo.id} value={repo.id}>{repo.name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="mb-4">
                      <label className="mb-1.5 block text-xs font-medium">Default Branch</label>
                      {loadingBranches ? (
                        <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Loading branches...
                        </div>
                      ) : (
                        <select
                          className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                          value={defaultBranchValue}
                          onChange={(e) => { setDefaultBranchValue(e.target.value); setDirty(true); }}
                        >
                          {!branches.includes(defaultBranchValue) && defaultBranchValue && (
                            <option value={defaultBranchValue}>{defaultBranchValue}</option>
                          )}
                          {branches.map((branch) => (
                            <option key={branch} value={branch}>{branch}</option>
                          ))}
                        </select>
                      )}
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        New worktrees will be created from this branch.
                      </p>
                    </div>

                    <div className="mb-4">
                      <label className="mb-1.5 block text-xs font-medium">Run Script</label>
                      <textarea
                        className="w-full rounded-md border border-border/50 bg-secondary/30 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                        rows={3}
                        placeholder={"npm run dev\ndocker-compose up"}
                        value={runScriptText}
                        onChange={(e) => { setRunScriptText(e.target.value); setDirty(true); }}
                      />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        One command per line. Executed when you tap the Run button in the chat panel.
                      </p>
                    </div>

                    <div className="mb-4">
                      <label className="mb-1.5 block text-xs font-medium">Setup Scripts</label>
                      <textarea
                        className="w-full rounded-md border border-border/50 bg-secondary/30 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                        rows={5}
                        placeholder={"bun install\ncp .env.example .env"}
                        value={setupText}
                        onChange={(e) => { setSetupText(e.target.value); setDirty(true); }}
                      />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        One command per line. Runs sequentially after worktree creation.
                      </p>
                    </div>

                    <div className="mb-4">
                      <label className="mb-1.5 block text-xs font-medium">Teardown Scripts</label>
                      <textarea
                        className="w-full rounded-md border border-border/50 bg-secondary/30 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                        rows={5}
                        placeholder="docker-compose down"
                        value={teardownText}
                        onChange={(e) => { setTeardownText(e.target.value); setDirty(true); }}
                      />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        One command per line. Runs sequentially before worktree deletion.
                      </p>
                    </div>

                    <div className="mt-auto flex items-center justify-between border-t border-border/30 pt-4">
                      {selectedRepo ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive -ml-2"
                          onClick={() => setShowRemoveDialog(true)}
                        >
                          Remove Repository
                        </Button>
                      ) : <div />}

                      <div className="flex h-5 items-center text-xs text-muted-foreground">
                        {saving && (
                          <span className="flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Saving
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center">
                    <p className="text-xs text-muted-foreground">No repositories available</p>
                  </div>
                )}
              </>
            ) : activeTab === "models" ? (
              /* ── Models Tab ── */
              <>
                {loadingModels ? (
                  <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading...
                  </div>
                ) : (
                  <div className="mb-4">
                    <div className="mb-2 flex items-center justify-between">
                      <label className="text-xs font-medium">Model Providers</label>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-2 text-xs"
                        onClick={() => {
                          resetProviderForm("claude");
                          setShowProviderForm(true);
                        }}
                      >
                        <Plus className="h-3 w-3" />
                        Add
                      </Button>
                    </div>

                    {providers.length === 0 && !showProviderForm && (
                      <p className="text-[10px] text-muted-foreground">
                        No custom models configured yet. Add Anthropic- or OpenAI-compatible entries here.
                        Anthropic entries can target Claude-compatible backends; OpenAI entries appear under Codex in the composer.
                      </p>
                    )}

                    {providers.length > 0 && (
                      <div className="space-y-2">
                        {providers.map((provider) => (
                          <div
                            key={provider.id}
                            className="rounded-lg border border-border/50 bg-secondary/20 p-2.5 text-xs"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                                  {getProviderCompatibilityLabel(provider.agent)}
                                </span>
                                <span className="font-medium">{provider.modelId}</span>
                                <span className="text-muted-foreground">·</span>
                                <span className="text-muted-foreground">{provider.name}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                                  aria-label={`Edit ${getProviderCompatibilityLabel(provider.agent)} provider ${provider.name} (${provider.modelId})`}
                                  title={`Edit ${provider.name}`}
                                  onClick={() => handleEditProvider(provider)}
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  aria-label={`Delete ${getProviderCompatibilityLabel(provider.agent)} provider ${provider.name} (${provider.modelId})`}
                                  title={`Delete ${provider.name}`}
                                  onClick={() => void handleDeleteProvider(provider.id)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {provider.baseUrl ? (
                                <>
                                  <span className="break-all">{provider.baseUrl}</span>
                                  <span className="mx-1.5">·</span>
                                </>
                              ) : null}
                              {provider.apiKeyMasked ? (
                                <span className="font-mono">{provider.apiKeyMasked}</span>
                              ) : (
                                <span>No endpoint override</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Provider form */}
                    {showProviderForm && (
                      <div className="mt-3 rounded-lg border border-border/50 bg-secondary/10 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-xs font-medium">
                            {editingProviderId ? "Edit Provider" : "Add Provider"}
                          </span>
                          <button
                            type="button"
                            className="rounded-md p-0.5 text-muted-foreground hover:text-foreground"
                            onClick={() => resetProviderForm(providerAgent)}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="space-y-2">
                          <div>
                            <label className="mb-0.5 block text-[10px] text-muted-foreground">API Compatibility</label>
                            <select
                              className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                              value={providerCompatibility}
                              onChange={(e) => {
                                setProviderAgent(AGENT_BY_API_COMPATIBILITY[e.target.value as ApiCompatibility]);
                                setTestResult(null);
                              }}
                            >
                              <option value="anthropic">Anthropic</option>
                              <option value="openai">OpenAI</option>
                            </select>
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px] text-muted-foreground">Provider Name</label>
                            <input
                              type="text"
                              className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder='e.g. "z.ai", "OpenRouter"'
                              value={providerName}
                              onChange={(e) => setProviderName(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px] text-muted-foreground">Model ID</label>
                            <input
                              type="text"
                              className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder={providerModelPlaceholder}
                              value={providerModelId}
                              onChange={(e) => setProviderModelId(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px] text-muted-foreground">Base URL (optional)</label>
                            <input
                              type="text"
                              className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder={providerCompatibility === "anthropic" ? "e.g. https://api.z.ai/v1" : "Leave empty to use Codex CLI defaults"}
                              value={providerBaseUrl}
                              onChange={(e) => setProviderBaseUrl(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px] text-muted-foreground">API Key (optional)</label>
                            <input
                              type="password"
                              className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder={editingProviderId ? "Leave empty to keep current" : providerCompatibility === "anthropic" ? "API Key" : "Only if your Codex setup needs it"}
                              value={providerApiKey}
                              onChange={(e) => setProviderApiKey(e.target.value)}
                            />
                          </div>
                          <p className="text-[10px] leading-relaxed text-muted-foreground">
                            {providerCompatibility === "anthropic"
                              ? "Use an empty Base URL and API key to register a Claude-side model alias that relies on local CLI auth. Provide both when targeting an Anthropic-compatible remote endpoint."
                              : "OpenAI-compatible entries can be simple model aliases like gpt-5.4 or point to a custom endpoint if your environment requires it."}
                          </p>
                          {testResult && (
                            <div className={`rounded-md px-2.5 py-1.5 text-xs ${testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-destructive/10 text-destructive"}`}>
                              {testResult.success ? providerTestSuccessMessage : testResult.error}
                            </div>
                          )}
                          <div className="flex justify-end gap-2 pt-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => resetProviderForm(providerAgent)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={!canTestProvider || testingProvider}
                              onClick={() => void handleTestProvider()}
                            >
                              {testingProvider ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              disabled={!canSaveProvider || savingProvider}
                              onClick={() => void handleSaveProvider()}
                            >
                              {savingProvider ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}

                    <p className="mt-3 text-[10px] text-muted-foreground">
                      {providerFootnote}
                    </p>
                  </div>
                )}
              </>
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
