import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { THIRD_PARTY_LICENSES } from "../../lib/thirdPartyLicenses";
import type { ModelProvider, Repository } from "@codesymphony/shared-types";

type SettingsTab = "workspace" | "models" | "licenses";

type RepositoryFormState = {
  runScriptText: string;
  setupText: string;
  teardownText: string;
  defaultBranchValue: string;
};

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

  // ── Models tab state ──
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  // Provider form state
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerName, setProviderName] = useState("");
  const [providerModelId, setProviderModelId] = useState("");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);
  const [testingProvider, setTestingProvider] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

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

  // ── Models: Fetch providers when tab opens ──
  useEffect(() => {
    if (!open || activeTab !== "models") return;
    let cancelled = false;
    setLoadingModels(true);
    api.listModelProviders()
      .then((data) => {
        if (cancelled) {
          return;
        }

        setProviders(data);
        onProvidersChanged?.(data);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [open, activeTab, onProvidersChanged]);

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

  // ── Models: provider CRUD ──
  const refreshProviders = useCallback(async () => {
    try {
      const data = await api.listModelProviders();
      setProviders(data);
      onProvidersChanged?.(data);
    } catch {}
  }, [onProvidersChanged]);

  const handleSaveProvider = useCallback(async () => {
    if (!providerName.trim() || !providerModelId.trim() || !providerBaseUrl.trim() || (!editingProviderId && !providerApiKey.trim())) return;
    setSavingProvider(true);
    try {
      if (editingProviderId) {
        await api.updateModelProvider(editingProviderId, {
          name: providerName,
          modelId: providerModelId,
          baseUrl: providerBaseUrl,
          ...(providerApiKey.trim() ? { apiKey: providerApiKey } : {}),
        });
      } else {
        await api.createModelProvider({
          name: providerName,
          modelId: providerModelId,
          baseUrl: providerBaseUrl,
          apiKey: providerApiKey,
        });
      }
      setShowProviderForm(false);
      setEditingProviderId(null);
      setProviderName("");
      setProviderModelId("");
      setProviderBaseUrl("");
      setProviderApiKey("");
      await refreshProviders();
    } catch {
      // non-critical
    } finally {
      setSavingProvider(false);
    }
  }, [editingProviderId, providerName, providerModelId, providerBaseUrl, providerApiKey, refreshProviders]);

  const handleDeleteProvider = useCallback(async (id: string) => {
    try {
      await api.deleteModelProvider(id);
      await refreshProviders();
    } catch {}
  }, [refreshProviders]);

  const handleEditProvider = useCallback((provider: ModelProvider) => {
    setEditingProviderId(provider.id);
    setProviderName(provider.name);
    setProviderModelId(provider.modelId);
    setProviderBaseUrl(provider.baseUrl);
    setProviderApiKey("");
    setShowProviderForm(true);
    setTestResult(null);
  }, []);

  const handleTestProvider = useCallback(async () => {
    if (!providerBaseUrl.trim() || !providerApiKey.trim() || !providerModelId.trim()) return;
    setTestingProvider(true);
    setTestResult(null);
    try {
      const result = await api.testModelProvider({
        baseUrl: providerBaseUrl,
        apiKey: providerApiKey,
        modelId: providerModelId,
      });
      setTestResult(result);
    } catch {
      setTestResult({ success: false, error: "Network error — could not reach the runtime" });
    } finally {
      setTestingProvider(false);
    }
  }, [providerBaseUrl, providerApiKey, providerModelId]);

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
                          setEditingProviderId(null);
                          setProviderName("");
                          setProviderModelId("");
                          setProviderBaseUrl("");
                          setProviderApiKey("");
                          setTestResult(null);
                          setShowProviderForm(true);
                        }}
                      >
                        <Plus className="h-3 w-3" />
                        Add
                      </Button>
                    </div>

                    {providers.length === 0 && !showProviderForm && (
                      <p className="text-[10px] text-muted-foreground">
                        No model providers configured. Using Claude CLI authentication (default).
                        Add a provider to use a custom Anthropic-compatible API with a specific model.
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
                                <span className="font-medium">{provider.modelId}</span>
                                <span className="text-muted-foreground">·</span>
                                <span className="text-muted-foreground">{provider.name}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                                  title="Edit"
                                  onClick={() => handleEditProvider(provider)}
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                  title="Delete"
                                  onClick={() => void handleDeleteProvider(provider.id)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              <span className="break-all">{provider.baseUrl}</span>
                              <span className="mx-1.5">·</span>
                              <span className="font-mono">{provider.apiKeyMasked}</span>
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
                            onClick={() => setShowProviderForm(false)}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                        <div className="space-y-2">
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
                              placeholder='e.g. "claude-sonnet-4-6", "glm-4.7"'
                              value={providerModelId}
                              onChange={(e) => setProviderModelId(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px] text-muted-foreground">Base URL</label>
                            <input
                              type="text"
                              className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder="e.g. https://api.z.ai/v1"
                              value={providerBaseUrl}
                              onChange={(e) => setProviderBaseUrl(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="mb-0.5 block text-[10px] text-muted-foreground">API Key</label>
                            <input
                              type="password"
                              className="w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                              placeholder={editingProviderId ? "Leave empty to keep current" : "API Key"}
                              value={providerApiKey}
                              onChange={(e) => setProviderApiKey(e.target.value)}
                            />
                          </div>
                          {testResult && (
                            <div className={`rounded-md px-2.5 py-1.5 text-xs ${testResult.success ? "bg-emerald-500/10 text-emerald-400" : "bg-destructive/10 text-destructive"}`}>
                              {testResult.success ? "Connection successful — provider is Anthropic-compatible." : testResult.error}
                            </div>
                          )}
                          <div className="flex justify-end gap-2 pt-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => { setShowProviderForm(false); setTestResult(null); }}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={testingProvider || !providerModelId.trim() || !providerBaseUrl.trim() || !providerApiKey.trim()}
                              onClick={() => void handleTestProvider()}
                            >
                              {testingProvider ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              disabled={savingProvider || !providerName.trim() || !providerModelId.trim() || !providerBaseUrl.trim() || (!editingProviderId && !providerApiKey.trim())}
                              onClick={() => void handleSaveProvider()}
                            >
                              {savingProvider ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}

                    <p className="mt-3 text-[10px] text-muted-foreground">
                      Providers must use the Anthropic Messages API format (/v1/messages).
                      OpenAI-compatible providers (x.ai, OpenAI, etc.) are not supported.
                      Add and edit providers here, then choose the model you want from the composer.
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
