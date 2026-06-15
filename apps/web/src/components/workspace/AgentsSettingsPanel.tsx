import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleCheck, CircleDashed, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentConfig, CliAgent, TestAgentConfigResult } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { AgentIcon } from "./composer/AgentModelSelector";

const SETTINGS_INPUT_CLASS_NAME =
  "h-9 w-full rounded-lg border border-border/60 bg-background/20 px-3 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30";

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

function TestResultInline({ result }: { result: TestAgentConfigResult | null }) {
  if (!result) return null;
  const ok = result.ok;
  const text = ok ? (result.detail ?? "Looks good.") : (result.error ?? "Test failed.");
  return (
    <div
      role="status"
      title={text}
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-[11px] leading-4",
        ok ? "text-emerald-500" : "text-amber-500",
      )}
    >
      {ok ? (
        <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{text}</span>
    </div>
  );
}

type StatusCardProps = {
  agent: CliAgent;
  label: string;
  ok: boolean;
  detail: string;
};

function StatusCard({ agent, label, ok, detail }: StatusCardProps) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/30 p-3">
      <div className="flex items-center justify-between">
        <AgentIcon agent={agent} className="h-4 w-4 text-muted-foreground" />
        {ok ? (
          <CircleCheck className="h-4 w-4 text-emerald-500" aria-label="Configured" />
        ) : (
          <CircleDashed className="h-4 w-4 text-muted-foreground" aria-label="Not configured" />
        )}
      </div>
      <div className="mt-3 text-[13px] font-semibold text-foreground">{label}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

type AgentRowProps = {
  agent: CliAgent;
  label: string;
  description: string;
  inputValue: string;
  inputAriaLabel: string;
  inputClassName?: string;
  inputPlaceholder?: string;
  inputTestId?: string;
  inputAutoComplete?: string;
  onInputChange: (value: string) => void;
  onTest: () => void;
  onSave: () => void;
  testLoading: boolean;
  testResult: TestAgentConfigResult | null;
  testDisabled?: boolean;
  saveDisabled: boolean;
  testid: string;
};

/**
 * Single agent row: 2 baris stabil.
 * Baris 1: icon + title + description
 * Baris 2: input + tombol Test/Save (sejajar)
 * Test result direservasi area-nya (min-h) supaya layout tidak naik/turun.
 */
function AgentRow({
  agent,
  label,
  description,
  inputValue,
  inputAriaLabel,
  inputClassName,
  inputPlaceholder,
  inputTestId,
  inputAutoComplete,
  onInputChange,
  onTest,
  onSave,
  testLoading,
  testResult,
  testDisabled,
  saveDisabled,
  testid,
}: AgentRowProps) {
  return (
    <div className="flex flex-col gap-3 p-4" data-testid={testid}>
      {/* Baris 1: icon + title (kiri), test result (kanan, sejajar dengan title) + description di bawah title */}
      <div className="flex items-start gap-3">
        <AgentIcon agent={agent} className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] font-medium text-foreground">{label}</div>
            {testResult ? (
              <div className="min-w-0 max-w-[260px]">
                <TestResultInline result={testResult} />
              </div>
            ) : null}
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>

      {/* Baris 2: input + tombol — sejajar di tinggi yang sama */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          className={cn(SETTINGS_INPUT_CLASS_NAME, "min-w-0 flex-1", inputClassName)}
          value={inputValue}
          aria-label={inputAriaLabel}
          placeholder={inputPlaceholder}
          data-testid={inputTestId}
          autoComplete={inputAutoComplete}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onInputChange(event.target.value)}
        />
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={onTest}
            disabled={testLoading || testDisabled}
          >
            {testLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-9"
            onClick={onSave}
            disabled={saveDisabled}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
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

      {/* ── Status overview ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {PATH_AGENTS.map(({ agent, configKey, resolvedKey, label }) => {
          const resolved = config?.[resolvedKey] ?? "";
          // Resolved path counts as "found" when it has been resolved to a real
          // filesystem path (contains "/"). A bare command name (e.g. "claude")
          // means the CLI couldn't be located on PATH.
          const isResolved = resolved.includes("/");
          const isCustom = Boolean(config && (config[configKey] ?? "").trim().length > 0);
          const detail = !config
            ? "Loading…"
            : isCustom
              ? "Custom path"
              : isResolved
                ? "System default"
                : "Not found on PATH";
          return (
            <StatusCard
              key={agent}
              agent={agent}
              label={label}
              ok={isResolved}
              detail={detail}
            />
          );
        })}
        <StatusCard
          agent="cursor"
          label="Cursor"
          ok={Boolean(config?.cursorApiKeySet)}
          detail={config?.cursorApiKeySet ? "Key configured" : "Not configured"}
        />
      </div>

      {/* ── Inline action list ── */}
      <div className="rounded-xl border border-border/60 bg-card/30 divide-y divide-border/40">
        {PATH_AGENTS.map(({ agent, configKey, label, description }) => {
          const test = testState[agent];
          return (
            <AgentRow
              key={agent}
              agent={agent}
              label={label}
              description={description}
              inputValue={pathValues[agent] ?? ""}
              inputAriaLabel={`${label} CLI path`}
              onInputChange={(value) =>
                setPathValues((prev) => ({ ...prev, [agent]: value }))
              }
              onTest={() => { void runTest(agent, pathValues[agent] ?? ""); }}
              onSave={() => handleSavePath(configKey, agent)}
              testLoading={Boolean(test?.loading)}
              testResult={test?.result ?? null}
              saveDisabled={!dirtyPaths[agent] || updateMutation.isPending}
              testid={`agent-section-${agent}`}
            />
          );
        })}

        <AgentRow
          agent="cursor"
          label="Cursor"
          description="Cursor uses an API key via the Cursor SDK. When a key is set, only its first and last characters are shown — edit the field to replace it."
          inputValue={cursorKeyDraft}
          inputAriaLabel="Cursor API key"
          inputPlaceholder="Set Cursor API key"
          inputClassName="font-mono"
          inputTestId="cursor-key-input"
          inputAutoComplete="off"
          onInputChange={setCursorKeyDraft}
          // When the field still shows the masked stored key (not edited), send
          // an empty string so the backend falls back to the saved key. When
          // edited, send the new key from the field.
          onTest={() => {
            const valueToTest = cursorDirty ? cursorKeyDraft : "";
            void runTest("cursor", valueToTest);
          }}
          onSave={() => updateMutation.mutate({ cursorApiKey: cursorKeyDraft })}
          testLoading={Boolean(testState.cursor?.loading)}
          testResult={testState.cursor?.result ?? null}
          // Test is enabled when there is something to test: either a saved key
          // exists, or the user has typed a non-empty key into the field.
          testDisabled={
            !config?.cursorApiKeySet
            && (!cursorDirty || cursorKeyDraft.trim().length === 0)
          }
          saveDisabled={!cursorDirty || cursorKeyDraft.trim().length === 0 || updateMutation.isPending}
          testid="agent-section-cursor"
        />
      </div>
    </div>
  );
}
