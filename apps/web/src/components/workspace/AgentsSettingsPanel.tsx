import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig, CliAgent, TestAgentConfigResult } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";

const SETTINGS_INPUT_CLASS_NAME =
  "w-full rounded-lg border border-border/60 bg-background/20 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30";

type PathAgent = Extract<CliAgent, "claude" | "codex" | "opencode">;

const PATH_AGENTS: Array<{
  agent: PathAgent;
  configKey: "claudePath" | "codexPath" | "opencodePath";
  resolvedKey: "claudePathResolved" | "codexPathResolved" | "opencodePathResolved";
  label: string;
  description: string;
}> = [
  {
    agent: "claude",
    configKey: "claudePath",
    resolvedKey: "claudePathResolved",
    label: "Claude Code",
    description: "Path to the Claude Code CLI. The current path is shown below; edit it to use a custom binary.",
  },
  {
    agent: "codex",
    configKey: "codexPath",
    resolvedKey: "codexPathResolved",
    label: "Codex",
    description: "Path to the Codex CLI. The current path is shown below; edit it to use a custom binary.",
  },
  {
    agent: "opencode",
    configKey: "opencodePath",
    resolvedKey: "opencodePathResolved",
    label: "OpenCode",
    description: "Path to the OpenCode CLI. The current path is shown below; edit it to use a custom binary.",
  },
];

type TestState = Record<string, { loading: boolean; result: TestAgentConfigResult | null }>;

function TestResultText({ result }: { result: TestAgentConfigResult | null }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <p className="mt-2 text-[11px] leading-5 text-emerald-500" role="status">
        {result.detail ?? "Looks good."}
      </p>
    );
  }
  return (
    <p className="mt-2 text-[11px] leading-5 text-amber-500" role="status">
      {result.error ?? "Test failed."}
    </p>
  );
}

export function AgentsSettingsPanel() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: queryKeys.agentConfig.all,
    queryFn: () => api.getAgentConfig(),
    staleTime: 60_000,
  });

  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [cursorKeyDraft, setCursorKeyDraft] = useState("");
  const [testState, setTestState] = useState<TestState>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const config = configQuery.data;

  useEffect(() => {
    if (!config) return;
    setPathValues({
      claude: config.claudePathResolved,
      codex: config.codexPathResolved,
      opencode: config.opencodePathResolved,
    });
    setCursorKeyDraft(config.cursorApiKeySet ? config.cursorApiKeyMasked : "");
  }, [config]);

  const updateMutation = useMutation({
    mutationFn: (input: Parameters<typeof api.updateAgentConfig>[0]) => api.updateAgentConfig(input),
    onSuccess: (next: AgentConfig) => {
      queryClient.setQueryData(queryKeys.agentConfig.all, next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentConfig.all });
      setCursorKeyDraft("");
      setSaveError(null);
    },
    onError: (error: unknown) => {
      setSaveError(error instanceof Error ? error.message : "Failed to save agent config");
    },
  });

  const runTest = useCallback(async (agent: CliAgent, value: string) => {
    setTestState((prev) => ({ ...prev, [agent]: { loading: true, result: null } }));
    try {
      const result = await api.testAgentConfig({ agent, value });
      setTestState((prev) => ({ ...prev, [agent]: { loading: false, result } }));
    } catch (error) {
      setTestState((prev) => ({
        ...prev,
        [agent]: {
          loading: false,
          result: { ok: false, error: error instanceof Error ? error.message : "Test failed" },
        },
      }));
    }
  }, []);

  const handleSavePath = useCallback(
    (configKey: "claudePath" | "codexPath" | "opencodePath", agent: PathAgent) => {
      updateMutation.mutate({ [configKey]: pathValues[agent] ?? "" });
    },
    [pathValues, updateMutation],
  );

  const dirtyPaths = useMemo(() => {
    if (!config) return {} as Record<string, boolean>;
    return {
      claude: (pathValues.claude ?? "") !== config.claudePathResolved,
      codex: (pathValues.codex ?? "") !== config.codexPathResolved,
      opencode: (pathValues.opencode ?? "") !== config.opencodePathResolved,
    };
  }, [config, pathValues]);

  // The Cursor field is prefilled with the masked key when one is set; it is only
  // "dirty" once the user edits it to something other than the displayed mask.
  const cursorBaseline = config?.cursorApiKeySet ? config.cursorApiKeyMasked : "";
  const cursorDirty = cursorKeyDraft !== cursorBaseline;

  return (
    <div className="space-y-4" data-testid="agents-settings">
      <div className="hidden md:block">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">Agents</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted-foreground">
          Configure custom CLI paths and credentials for each coding agent. Changes apply immediately
          without restarting the runtime.
        </p>
      </div>

      {saveError ? (
        <p className="text-[12px] text-destructive" role="alert">{saveError}</p>
      ) : null}

      <div className="space-y-3">
        {PATH_AGENTS.map(({ agent, configKey, label, description }) => {
          const test = testState[agent];
          const isCustom = Boolean(config && (config[configKey] ?? "").trim().length > 0);
          return (
            <section
              key={agent}
              className="rounded-xl border border-border/60 bg-card/30 p-4"
              data-testid={`agent-section-${agent}`}
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[13px] font-semibold text-foreground">{label}</h2>
                <span
                  className={
                    isCustom
                      ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                      : "rounded-full bg-secondary/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  }
                >
                  {isCustom ? "Custom" : "Default"}
                </span>
              </div>
              <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">{description}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  className={SETTINGS_INPUT_CLASS_NAME}
                  value={pathValues[agent] ?? ""}
                  aria-label={`${label} CLI path`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) =>
                    setPathValues((prev) => ({ ...prev, [agent]: event.target.value }))
                  }
                />
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => { void runTest(agent, pathValues[agent] ?? ""); }}
                    disabled={test?.loading}
                  >
                    {test?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleSavePath(configKey, agent)}
                    disabled={!dirtyPaths[agent] || updateMutation.isPending}
                  >
                    Save
                  </Button>
                </div>
              </div>
              <TestResultText result={test?.result ?? null} />
            </section>
          );
        })}

        <section
          className="rounded-xl border border-border/60 bg-card/30 p-4"
          data-testid="agent-section-cursor"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-semibold text-foreground">Cursor</h2>
            <span
              className={
                config?.cursorApiKeySet
                  ? "rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                  : "rounded-full bg-secondary/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              }
            >
              {config?.cursorApiKeySet ? "Key set" : "Not set"}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-muted-foreground">
            Cursor uses an API key via the Cursor SDK. When a key is set, only its first and last
            characters are shown — edit the field to replace it.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              className={`${SETTINGS_INPUT_CLASS_NAME} font-mono`}
              value={cursorKeyDraft}
              data-testid="cursor-key-input"
              placeholder="Set Cursor API key"
              aria-label="Cursor API key"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              onChange={(event) => setCursorKeyDraft(event.target.value)}
            />
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { void runTest("cursor", cursorKeyDraft); }}
                disabled={testState.cursor?.loading || !cursorDirty || cursorKeyDraft.trim().length === 0}
              >
                {testState.cursor?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => updateMutation.mutate({ cursorApiKey: cursorKeyDraft })}
                disabled={!cursorDirty || cursorKeyDraft.trim().length === 0 || updateMutation.isPending}
              >
                Save
              </Button>
            </div>
          </div>
          <TestResultText result={testState.cursor?.result ?? null} />
        </section>
      </div>
    </div>
  );
}
