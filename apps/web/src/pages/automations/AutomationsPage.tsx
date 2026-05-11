import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  Automation,
  AutomationRun,
  ChatMode,
  ChatThreadPermissionMode,
  CliAgent,
  CodexModelCatalogEntry,
  CursorModelCatalogEntry,
  ModelProvider,
  OpencodeModelCatalogEntry,
  Repository,
} from "@codesymphony/shared-types";
import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  DEFAULT_CHAT_MODEL_BY_AGENT,
} from "@codesymphony/shared-types";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { queryKeys } from "../../lib/queryKeys";
import { useRepositories } from "../../hooks/queries/useRepositories";
import {
  AGENT_LABELS,
  AgentIcon,
  CLI_AGENTS,
  buildAgentSelectionOptions,
  getCurrentAgentSelectionOption,
  isFirstCustomModelOption,
  type AgentModelSelection,
  type AgentSelectionOption,
} from "../../components/workspace/composer/AgentModelSelector";
import { useCodexModels } from "../../hooks/queries/useCodexModels";
import { useCursorModels } from "../../hooks/queries/useCursorModels";
import { useOpencodeModels } from "../../hooks/queries/useOpencodeModels";
import { useRuntimeInfo } from "../../hooks/queries/useRuntimeInfo";
import { useModelProviders } from "../workspace/hooks/useModelProviders";
import { useWorkspaceSyncStream } from "../workspace/hooks/useWorkspaceSyncStream";
import { AutomationPromptEditor } from "./AutomationPromptEditor";
import {
  AUTOMATION_WEEKDAYS,
  buildAutomationRrule,
  parseAutomationRrule,
  type AutomationScheduleDraft,
} from "./schedule";

type AutomationFormState = {
  repositoryId: string;
  targetWorktreeId: string;
  name: string;
  prompt: string;
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
  permissionMode: ChatThreadPermissionMode;
  chatMode: ChatMode;
  timezone: string;
  frequency: AutomationScheduleDraft["frequency"];
  hour: number;
  minute: number;
  daysOfWeek: string[];
};

type AutomationPageLayout = "page" | "panel";

type AutomationListPageProps = {
  prefills?: Partial<{
    repositoryId: string;
    worktreeId: string;
    agent: CliAgent;
    model: string;
    permissionMode: ChatThreadPermissionMode;
    chatMode: ChatMode;
    create: boolean;
  }>;
  layout?: AutomationPageLayout;
  onOpenAutomation?: (automationId: string) => void;
  onCreateDialogOpenChange?: (open: boolean) => void;
};

type AutomationDetailPageProps = {
  automationId: string;
  layout?: AutomationPageLayout;
  onBack?: () => void;
};

type WorkspaceAutomationsPanelProps = {
  automationId?: string | null;
  create?: boolean;
  prefills?: Omit<NonNullable<AutomationListPageProps["prefills"]>, "create">;
  onOpenAutomation: (automationId: string) => void;
  onBack: () => void;
  onCreateDialogOpenChange?: (open: boolean) => void;
};

type AutomationEnabledFilter = "all" | "enabled" | "paused";

const AUTOMATION_STATUS_FILTER_OPTIONS: Array<{
  value: AutomationEnabledFilter;
  label: string;
}> = [
  { value: "enabled", label: "Active" },
  { value: "all", label: "All" },
  { value: "paused", label: "Paused" },
];

const rememberedAutomationListState: {
  repositoryFilter: string | null;
  enabledFilter: "all" | "enabled" | "paused";
} = {
  repositoryFilter: null,
  enabledFilter: "enabled",
};

const AUTOMATION_PERMISSION_OPTIONS: Array<{
  value: ChatThreadPermissionMode;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
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

function getCurrentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function normalizeTimezone(timezone: string | null | undefined): string {
  const value = timezone?.trim();
  return value && value.length > 0 ? value : getCurrentTimezone();
}

function findRootWorktree(repository: Repository | undefined) {
  if (!repository) {
    return null;
  }

  const rootMatch = repository.worktrees.find((worktree) => worktree.path === repository.rootPath && worktree.status === "active");
  if (rootMatch) {
    return rootMatch;
  }

  return repository.worktrees.find((worktree) => worktree.status === "active") ?? null;
}

function findRepositoryById(repositories: Repository[], repositoryId: string) {
  return repositories.find((repository) => repository.id === repositoryId);
}

function defaultModelForAgent(agent: CliAgent): string {
  const builtinDefault = DEFAULT_CHAT_MODEL_BY_AGENT[agent];
  if (builtinDefault && builtinDefault.trim().length > 0) {
    return builtinDefault;
  }
  if (agent === "codex") {
    return "gpt-5.4";
  }
  return "claude-sonnet-4-6";
}

function formatDateTime(input: string | null) {
  if (!input) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(input));
}

function formatRelativeTime(input: string | null) {
  if (!input) {
    return "Never";
  }

  const deltaMs = new Date(input).getTime() - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (Math.abs(deltaMinutes) < 60) {
    return formatter.format(deltaMinutes, "minute");
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return formatter.format(deltaHours, "hour");
  }

  const deltaDays = Math.round(deltaHours / 24);
  return formatter.format(deltaDays, "day");
}

function summarizeSchedule(automation: Pick<Automation, "rrule" | "timezone">) {
  const schedule = parseAutomationRrule(automation.rrule);
  if (schedule.frequency === "hourly") {
    return `Hourly at :${String(schedule.minute).padStart(2, "0")} (${automation.timezone})`;
  }

  if (schedule.frequency === "weekly") {
    return `Weekly on ${schedule.daysOfWeek.join(", ")} at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} (${automation.timezone})`;
  }

  return `Daily at ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} (${automation.timezone})`;
}

function getRunStatusVariant(status: string | null | undefined) {
  if (status === "failed" || status === "canceled") {
    return "destructive" as const;
  }
  if (status === "waiting_input") {
    return "secondary" as const;
  }
  if (status === "running" || status === "dispatching" || status === "queued") {
    return "default" as const;
  }
  return "outline" as const;
}

function toFormState(
  repositories: Repository[],
  providers: ModelProvider[],
  automation?: Automation | null,
  prefills?: AutomationListPageProps["prefills"],
): AutomationFormState {
  const repository = automation
    ? findRepositoryById(repositories, automation.repositoryId)
    : findRepositoryById(repositories, prefills?.repositoryId ?? repositories[0]?.id ?? "") ?? repositories[0];
  const rootWorktree = findRootWorktree(repository);
  const schedule = automation ? parseAutomationRrule(automation.rrule) : {
    frequency: "daily" as const,
    hour: 9,
    minute: 0,
    daysOfWeek: [],
  };
  const activeProvider = providers.find((provider) => provider.id === automation?.modelProviderId) ?? null;

  return {
    repositoryId: automation?.repositoryId ?? repository?.id ?? "",
    targetWorktreeId: automation?.targetWorktreeId ?? prefills?.worktreeId ?? rootWorktree?.id ?? "",
    name: automation?.name ?? "",
    prompt: automation?.prompt ?? "",
    agent: automation?.agent ?? prefills?.agent ?? "claude",
    model: automation?.model ?? prefills?.model ?? defaultModelForAgent(prefills?.agent ?? "claude"),
    modelProviderId: activeProvider?.id ?? null,
    permissionMode: automation?.permissionMode ?? prefills?.permissionMode ?? "default",
    chatMode: automation?.chatMode ?? "default",
    timezone: normalizeTimezone(automation?.timezone),
    frequency: schedule.frequency,
    hour: schedule.hour,
    minute: schedule.minute,
    daysOfWeek: schedule.daysOfWeek,
  };
}

function sanitizeFormState(form: AutomationFormState): AutomationFormState {
  return {
    ...form,
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    model: form.model.trim(),
    timezone: normalizeTimezone(form.timezone),
  };
}

function formToPayload(form: AutomationFormState) {
  const normalized = sanitizeFormState(form);

  return {
    repositoryId: normalized.repositoryId,
    targetWorktreeId: normalized.targetWorktreeId,
    name: normalized.name,
    prompt: normalized.prompt,
    agent: normalized.agent,
    model: normalized.model,
    modelProviderId: normalized.modelProviderId,
    permissionMode: normalized.permissionMode,
    chatMode: normalized.chatMode,
    rrule: buildAutomationRrule({
      frequency: normalized.frequency,
      hour: normalized.hour,
      minute: normalized.minute,
      daysOfWeek: normalized.daysOfWeek,
    }),
    timezone: normalized.timezone,
  };
}

function formToUpdatePayload(form: AutomationFormState) {
  const { repositoryId: _repositoryId, ...payload } = formToPayload(form);
  return payload;
}

function getAvailableWorktrees(repositories: Repository[], repositoryId: string) {
  const repository = findRepositoryById(repositories, repositoryId);
  return repository?.worktrees.filter((worktree) => worktree.status === "active") ?? [];
}

function getProvidersForAgent(providers: ModelProvider[], agent: CliAgent) {
  return providers.filter((provider) => provider.agent === agent);
}

function buildWorkspaceSearch(run: AutomationRun, repositoryId: string) {
  return {
    repoId: repositoryId,
    worktreeId: run.worktreeId,
    threadId: run.threadId ?? undefined,
    view: "chat" as const,
  };
}

function SectionLabel({ children }: { children: string }) {
  return <label className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">{children}</label>;
}

function FieldShell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}

function AutomationPageShell({
  layout,
  children,
}: {
  layout: AutomationPageLayout;
  children: React.ReactNode;
}) {
  if (layout === "panel") {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-background text-foreground">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-3 sm:px-4 lg:px-5">
          {children}
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:px-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        {children}
      </div>
    </main>
  );
}

function SelectField(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "w-full rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50",
        props.className,
      )}
    />
  );
}

function CompactSelectControl({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <SelectField
      {...props}
      className={cn("h-8", className)}
    />
  );
}

function CompactPopoverLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex w-full items-center justify-between gap-2 text-xs text-foreground", className)}>
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
    </span>
  );
}

function CompactPopoverButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "group inline-flex w-full items-center rounded-md border border-border/50 bg-secondary/30 px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

function CompactInputField(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Input
      {...props}
      className={cn(
        "h-auto border-0 bg-transparent px-0 py-0 text-sm shadow-none outline-none ring-0 focus-visible:ring-0 focus-visible:ring-offset-0",
        props.className,
      )}
    />
  );
}

function BareInputField(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Input
      {...props}
      className={cn(
        "h-auto border-0 bg-transparent px-0 py-0 text-[2.25rem] font-semibold tracking-[-0.03em] shadow-none outline-none ring-0 placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-[2.75rem]",
        props.className,
      )}
    />
  );
}

function formatClockTime(hour: number, minute: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 0, 1, hour, minute)));
}

function summarizeScheduleDraft(schedule: Pick<AutomationFormState, "frequency" | "hour" | "minute" | "daysOfWeek">) {
  if (schedule.frequency === "hourly") {
    return `Hourly at :${String(schedule.minute).padStart(2, "0")}`;
  }

  const timeLabel = formatClockTime(schedule.hour, schedule.minute);
  if (schedule.frequency === "weekly") {
    const isWeekdays =
      schedule.daysOfWeek.length === 5 &&
      ["MO", "TU", "WE", "TH", "FR"].every((day) => schedule.daysOfWeek.includes(day));
    if (isWeekdays) {
      return `Weekdays at ${timeLabel}`;
    }

    if (schedule.daysOfWeek.length === 0) {
      return `Weekly at ${timeLabel}`;
    }

    return `${schedule.daysOfWeek.join(", ")} at ${timeLabel}`;
  }

  return `Daily at ${timeLabel}`;
}

function summarizeCreateTarget(repository: Repository | undefined, worktreeId: string) {
  if (!repository) {
    return "Select local or worktree";
  }

  const worktree = repository.worktrees.find((entry) => entry.id === worktreeId) ?? null;
  if (!worktree) {
    return "Select local or worktree";
  }

  return findRootWorktree(repository)?.id === worktree.id ? "Local" : worktree.branch;
}

type AutomationPickerOption = {
  value: string;
  label: string;
};

function WorkspaceHeaderStylePickerTrigger({
  icon: Icon,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-9 min-w-0 shrink-0 justify-between gap-1 rounded-md px-2.5 text-[12px] font-medium text-foreground/80 hover:bg-secondary/40 hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
        <span className="truncate">{children}</span>
      </span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
    </Button>
  );
}

function AutomationInlinePicker({
  icon,
  ariaLabel,
  value,
  selectedLabel,
  options,
  onSelect,
  className,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  ariaLabel: string;
  value: string;
  selectedLabel: string;
  options: AutomationPickerOption[];
  onSelect: (value: string) => void;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <WorkspaceHeaderStylePickerTrigger
          icon={icon}
          aria-label={ariaLabel}
          className={cn("w-full", className)}
          data-testid={testId}
        >
          {selectedLabel}
        </WorkspaceHeaderStylePickerTrigger>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[236px] rounded-lg border-border/60 bg-popover/95 p-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.16)]"
      >
        <ScrollArea className="max-h-48">
          <div className="space-y-0.5 pr-0.5">
            {options.length > 0 ? options.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[11px] transition-colors",
                    selected
                      ? "bg-secondary/70 text-foreground"
                      : "text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
                  )}
                  onClick={() => {
                    if (selected) {
                      setOpen(false);
                      return;
                    }
                    onSelect(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{option.label}</span>
                </button>
              );
            }) : (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                No options available
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function AutomationSessionPicker({
  value,
  providers,
  codexModels,
  cursorModels,
  opencodeModels,
  codexBuiltinModelOverride,
  onSelectionChange,
  onPermissionModeChange,
  className,
  testId,
}: {
  value: Pick<AutomationFormState, "agent" | "model" | "modelProviderId" | "permissionMode">;
  providers: ModelProvider[];
  codexModels: readonly CodexModelCatalogEntry[];
  cursorModels: readonly CursorModelCatalogEntry[];
  opencodeModels: readonly OpencodeModelCatalogEntry[];
  codexBuiltinModelOverride?: string | null;
  onSelectionChange: (selection: AgentModelSelection) => void;
  onPermissionModeChange: (value: ChatThreadPermissionMode) => void;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [previewAgent, setPreviewAgent] = useState<CliAgent>(value.agent);
  const agentOptions = useMemo(() => buildAgentSelectionOptions({
    providers,
    codexModels,
    cursorModels,
    opencodeModels,
    codexBuiltinModelOverride,
  }), [codexBuiltinModelOverride, codexModels, cursorModels, opencodeModels, providers]);
  const selection = useMemo<AgentModelSelection>(() => ({
    agent: value.agent,
    model: value.model,
    modelProviderId: value.modelProviderId,
  }), [value.agent, value.model, value.modelProviderId]);
  const currentSelection = useMemo(
    () => getCurrentAgentSelectionOption(agentOptions, selection),
    [agentOptions, selection],
  );
  const modelOptions: AgentSelectionOption[] = agentOptions[previewAgent] ?? [];
  const activePermissionOption = AUTOMATION_PERMISSION_OPTIONS.find((option) => option.value === value.permissionMode)
    ?? AUTOMATION_PERMISSION_OPTIONS[0];
  const sessionLabel = `${AGENT_LABELS[value.agent]} · ${currentSelection.label}`;

  useEffect(() => {
    if (!open) {
      return;
    }

    setPreviewAgent(value.agent);
  }, [open, value.agent]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setPreviewAgent(value.agent);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select automation session"
          title={`${sessionLabel} · ${activePermissionOption.label}`}
          className={cn(
            "flex h-9 min-w-0 w-full shrink-0 items-center justify-between gap-1 rounded-md px-2.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-secondary/40 hover:text-foreground",
            className,
          )}
          data-testid={testId}
        >
          <span className="min-w-0 flex items-center gap-1.5">
            <AgentIcon agent={value.agent} aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="truncate">{sessionLabel}</span>
          </span>
          <span className="ml-2 flex shrink-0 items-center gap-1">
            {value.permissionMode === "full_access" ? (
              <ShieldCheck className="h-3.5 w-3.5 text-orange-500" />
            ) : null}
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[min(560px,calc(100vw-32px))] rounded-xl border-border/60 bg-popover p-0 shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
      >
        <div className="grid gap-0 sm:grid-cols-[148px_minmax(0,1fr)] sm:items-start">
          <div className="border-b border-border/50 p-1.5 sm:min-h-[240px] sm:border-b-0 sm:border-r sm:border-border/50">
            <div className="space-y-0.5">
              {CLI_AGENTS.map((entryAgent) => {
                const selectedAgent = previewAgent === entryAgent;
                const currentAgent = value.agent === entryAgent;

                return (
                  <button
                    key={entryAgent}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors",
                      selectedAgent
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50",
                    )}
                    aria-current={currentAgent ? "true" : undefined}
                    onMouseEnter={() => {
                      if (previewAgent !== entryAgent) {
                        setPreviewAgent(entryAgent);
                      }
                    }}
                    onFocus={() => {
                      if (previewAgent !== entryAgent) {
                        setPreviewAgent(entryAgent);
                      }
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      if (previewAgent !== entryAgent) {
                        setPreviewAgent(entryAgent);
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

          <div className="p-1.5">
            <ScrollArea className="h-[240px]">
              <div className="space-y-0.5 pr-0.5">
                {modelOptions.length > 0 ? modelOptions.map((option, index) => {
                  const selected = option.agent === value.agent
                    && option.model === value.model
                    && option.modelProviderId === value.modelProviderId;
                  const showCustomSeparator = isFirstCustomModelOption(modelOptions, index);

                  return (
                    <div key={option.id}>
                      {showCustomSeparator ? (
                        <div className="mx-2.5 my-1 border-t border-border/60" />
                      ) : null}
                      <button
                        type="button"
                        title={option.model}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                          selected
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground hover:bg-accent/50",
                        )}
                        onClick={() => {
                          onSelectionChange({
                            agent: option.agent,
                            model: option.model,
                            modelProviderId: option.modelProviderId,
                          });
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
                }) : (
                  <div className="px-2 py-2 text-[11px] text-muted-foreground">
                    No models available
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>

        <div className="border-t border-border/50 px-3 py-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/85">
            Access
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {AUTOMATION_PERMISSION_OPTIONS.map((option) => {
              const selected = option.value === value.permissionMode;

              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    selected
                      ? "border-border/70 bg-secondary/70 text-foreground"
                      : "border-transparent text-foreground hover:bg-secondary/45",
                  )}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onPermissionModeChange(option.value)}
                >
                  <option.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-foreground">{option.label}</span>
                    <span className="block text-[10px] leading-relaxed text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                  {selected ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function summarizeScheduleCompact(automation: Pick<Automation, "rrule" | "timezone">) {
  const schedule = parseAutomationRrule(automation.rrule);
  return summarizeScheduleDraft(schedule);
}

function InlineMetadataSeparator() {
  return <span className="shrink-0 text-muted-foreground/35">·</span>;
}

function toggleScheduleDay(daysOfWeek: string[], day: string) {
  return daysOfWeek.includes(day)
    ? daysOfWeek.filter((entry) => entry !== day)
    : [...daysOfWeek, day];
}

function ComposerFooterField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-[180px] space-y-1", className)}>
      <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SidebarRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[100px_minmax(0,1fr)] sm:items-start">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm text-foreground">{children}</div>
    </div>
  );
}

function AutomationScheduleEditor({
  form,
  onChange,
}: {
  form: AutomationFormState;
  onChange: (next: Partial<AutomationFormState>) => void;
}) {
  return (
    <div className="grid gap-4">
      <FieldShell label="Frequency">
        <SelectField
          value={form.frequency}
          onChange={(event) => onChange({ frequency: event.target.value as AutomationScheduleDraft["frequency"] })}
          className="shadow-none"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="hourly">Hourly</option>
        </SelectField>
      </FieldShell>

      <div className="grid gap-4 sm:grid-cols-2">
        <FieldShell label={form.frequency === "hourly" ? "Minute" : "Hour"}>
          <Input
            type="number"
            min={form.frequency === "hourly" ? 0 : 0}
            max={form.frequency === "hourly" ? 59 : 23}
            value={form.frequency === "hourly" ? form.minute : form.hour}
            onChange={(event) => {
              const nextValue = Number.parseInt(event.target.value, 10);
              if (form.frequency === "hourly") {
                onChange({ minute: Number.isNaN(nextValue) ? 0 : nextValue });
                return;
              }
              onChange({ hour: Number.isNaN(nextValue) ? 0 : nextValue });
            }}
            className="shadow-none"
          />
        </FieldShell>

        {form.frequency === "hourly" ? null : (
          <FieldShell label="Minute">
            <Input
              type="number"
              min={0}
              max={59}
              value={form.minute}
              onChange={(event) => {
                const nextValue = Number.parseInt(event.target.value, 10);
                onChange({ minute: Number.isNaN(nextValue) ? 0 : nextValue });
              }}
              className="shadow-none"
            />
          </FieldShell>
        )}
      </div>

      {form.frequency === "weekly" ? (
        <FieldShell label="Days">
          <div className="flex flex-wrap gap-2">
            {AUTOMATION_WEEKDAYS.map((day) => {
              const selected = form.daysOfWeek.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    selected
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border/60 bg-background text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                  onClick={() => onChange({ daysOfWeek: toggleScheduleDay(form.daysOfWeek, day) })}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </FieldShell>
      ) : (
        <FieldShell label="Summary">
          <div className="rounded-lg border border-dashed border-border/60 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
            {summarizeScheduleDraft(form)}
          </div>
        </FieldShell>
      )}
    </div>
  );
}

function AutomationRunList({
  automation,
  runs,
}: {
  automation: Automation;
  runs: AutomationRun[];
}) {
  return (
    <div className="space-y-3">
      {runs.length === 0 ? (
        <div className="border-t border-dashed border-border/50 pt-4 text-sm text-muted-foreground">
          No runs yet. Trigger a manual run to create the first thread.
        </div>
      ) : (
        <div className="divide-y divide-border/40 border-t border-border/40">
          {runs.map((run) => (
            <div key={run.id} className="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant={getRunStatusVariant(run.status)}>
                    {run.status.replaceAll("_", " ")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{formatRelativeTime(run.scheduledFor)}</span>
                </div>
                <p className="line-clamp-2 text-sm text-foreground">{run.summary ?? run.error ?? "Run linked to a workspace thread."}</p>
                <div className="text-xs text-muted-foreground">{formatDateTime(run.scheduledFor)}</div>
              </div>

              {run.threadId ? (
                <Link
                  to="/"
                  search={buildWorkspaceSearch(run, automation.repositoryId)}
                  className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:text-primary/80"
                >
                  Open
                  <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              ) : null}
            </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionHistoryList({
  versions,
  restoringVersionId,
  onRestore,
}: {
  versions: Array<{
    id: string;
    content: string;
    source: string;
    createdAt: string;
  }>;
  restoringVersionId: string | null;
  onRestore: (versionId: string) => void;
}) {
  return (
    <div className="space-y-3">
      {versions.length === 0 ? (
        <div className="border-t border-dashed border-border/50 pt-4 text-sm text-muted-foreground">
          Prompt versions will appear here after edits.
        </div>
      ) : (
        <div className="divide-y divide-border/40 border-t border-border/40">
          {versions.map((version) => (
            <div key={version.id} className="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{version.source}</Badge>
                  <span className="text-xs text-muted-foreground">{formatDateTime(version.createdAt)}</span>
                </div>
                <p className="line-clamp-3 text-sm text-foreground">{version.content}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={restoringVersionId === version.id}
                onClick={() => onRestore(version.id)}
              >
                {restoringVersionId === version.id ? "Restoring..." : "Restore"}
              </Button>
            </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AutomationRowActionButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

function AutomationListItem({
  automation,
  repositories,
  compactLayout,
  onOpen,
  onRun,
  onToggle,
  onDelete,
  runPending,
  togglePending,
  deletePending,
}: {
  automation: Automation;
  repositories: Repository[];
  compactLayout: boolean;
  onOpen: (automationId: string) => void;
  onRun: (automationId: string) => void;
  onToggle: (automationId: string, enabled: boolean) => void;
  onDelete: (automationId: string) => void;
  runPending: boolean;
  togglePending: boolean;
  deletePending: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const repository = findRepositoryById(repositories, automation.repositoryId);
  const scheduleSummary = summarizeScheduleCompact(automation);

  const stopEvent = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-secondary/70 focus-within:bg-secondary/70",
        moreOpen && "bg-secondary/70",
        !compactLayout && "py-3",
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => onOpen(automation.id)}
      >
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="truncate text-sm font-medium text-foreground sm:text-[15px]">
            {automation.name}
          </span>
          <InlineMetadataSeparator />
          <span className="truncate text-sm text-muted-foreground">
            {repository?.name ?? automation.repositoryId}
          </span>
        </div>
      </button>

      <div className={cn("relative flex shrink-0 items-center justify-end", compactLayout ? "min-w-[130px]" : "min-w-[160px]")}>
        <span
          className={cn(
            "whitespace-nowrap text-right text-sm text-muted-foreground transition-opacity",
            moreOpen && "opacity-0",
            !moreOpen && "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          {scheduleSummary}
        </span>

        <div
          className={cn(
            "pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-full bg-secondary/70 opacity-0 transition-opacity",
            moreOpen && "pointer-events-auto opacity-100",
            !moreOpen && "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
        >
          <AutomationRowActionButton
            aria-label={`Run now ${automation.name}`}
            disabled={runPending}
            onClick={(event) => {
              stopEvent(event);
              setMoreOpen(false);
              onRun(automation.id);
            }}
          >
            <Play className="h-3.5 w-3.5" />
          </AutomationRowActionButton>
          <AutomationRowActionButton
            aria-label={`Edit ${automation.name}`}
            onClick={(event) => {
              stopEvent(event);
              setMoreOpen(false);
              onOpen(automation.id);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </AutomationRowActionButton>
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <AutomationRowActionButton
                aria-label={`More actions for ${automation.name}`}
                onClick={(event) => {
                  stopEvent(event);
                  setMoreOpen((current) => !current);
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </AutomationRowActionButton>
            </PopoverTrigger>
            {moreOpen ? (
              <PopoverContent
                align="end"
                sideOffset={8}
                className="w-40 rounded-lg border-border/60 bg-popover/95 p-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.16)]"
              >
                <div className="space-y-0.5">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={togglePending}
                    onClick={(event) => {
                      stopEvent(event);
                      setMoreOpen(false);
                      onToggle(automation.id, !automation.enabled);
                    }}
                  >
                    {automation.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {automation.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={deletePending}
                    onClick={(event) => {
                      stopEvent(event);
                      setMoreOpen(false);
                      onDelete(automation.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </PopoverContent>
            ) : null}
          </Popover>
        </div>
      </div>
    </div>
  );
}

export function AutomationsListPage({
  prefills,
  layout = "page",
  onOpenAutomation,
  onCreateDialogOpenChange,
}: AutomationListPageProps) {
  useWorkspaceSyncStream();

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const repositoriesQuery = useRepositories();
  const { providers } = useModelProviders();
  const runtimeInfo = useRuntimeInfo();
  const codexModelsQuery = useCodexModels();
  const cursorModelsQuery = useCursorModels();
  const opencodeModelsQuery = useOpencodeModels();
  const repositories = repositoriesQuery.data;
  const [repositoryFilter, setRepositoryFilter] = useState(() => rememberedAutomationListState.repositoryFilter ?? "");
  const [enabledFilter, setEnabledFilter] = useState<"all" | "enabled" | "paused">(() => rememberedAutomationListState.enabledFilter);
  const [createDialogOpen, setCreateDialogOpen] = useState(prefills?.create ?? false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<AutomationFormState>(() => toFormState(repositories, providers, null, prefills));
  const compactLayout = layout === "panel";

  const handleCreateDialogOpenChange = useCallback((open: boolean) => {
    setCreateDialogOpen(open);
    onCreateDialogOpenChange?.(open);
  }, [onCreateDialogOpenChange]);

  useEffect(() => {
    if (repositories.length === 0) {
      return;
    }

    setCreateForm((current) => {
      if (current.repositoryId && current.targetWorktreeId) {
        return current;
      }
      return toFormState(repositories, providers, null, prefills);
    });
  }, [repositories, providers, prefills]);

  useEffect(() => {
    rememberedAutomationListState.repositoryFilter = repositoryFilter;
    rememberedAutomationListState.enabledFilter = enabledFilter;
  }, [enabledFilter, repositoryFilter]);

  const automationsQuery = useQuery({
    queryKey: queryKeys.automations.list(
      repositoryFilter || undefined,
      enabledFilter === "all" ? undefined : enabledFilter === "enabled",
    ),
    queryFn: () => api.listAutomations({
      repositoryId: repositoryFilter || undefined,
      enabled: enabledFilter === "all" ? undefined : enabledFilter === "enabled",
    }),
    refetchInterval: 10_000,
  });

  const openAutomationDetail = useCallback((automationId: string) => {
    if (onOpenAutomation) {
      onOpenAutomation(automationId);
      return;
    }

    startTransition(() => {
      void navigate({
        to: "/automations/$automationId",
        params: { automationId },
        search: {},
      });
    });
  }, [navigate, onOpenAutomation]);

  const createMutation = useMutation({
    mutationFn: api.createAutomation,
    onSuccess: (automation) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      handleCreateDialogOpenChange(false);
      setCreateError(null);
      setCreateForm(toFormState(repositories, providers, null, prefills));
      openAutomationDetail(automation.id);
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error.message : "Unable to create automation");
    },
  });

  const runMutation = useMutation({
    mutationFn: api.runAutomationNow,
    onSuccess: (_run, automationId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(automationId) });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ automationId, enabled }: { automationId: string; enabled: boolean }) =>
      api.updateAutomation(automationId, { enabled }),
    onSuccess: (_automation, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(variables.automationId) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteAutomation,
    onSuccess: (_result, automationId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      void queryClient.removeQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.removeQueries({ queryKey: queryKeys.automations.runs(automationId) });
      void queryClient.removeQueries({ queryKey: queryKeys.automations.versions(automationId) });
    },
  });

  const automations = automationsQuery.data ?? [];
  const createWorktrees = getAvailableWorktrees(repositories, createForm.repositoryId);
  const createRepository = findRepositoryById(repositories, createForm.repositoryId);
  const codexModels = codexModelsQuery.data?.models ?? [];
  const cursorModels = cursorModelsQuery.data?.models ?? [];
  const opencodeModels = opencodeModelsQuery.data?.models ?? [];
  const codexBuiltinModelOverride = runtimeInfo.data?.codexCliProviderOverride?.model ?? null;
  const createProjectOptions = repositories.map((repository) => ({
    value: repository.id,
    label: repository.name,
  }));
  const createTargetOptions = createWorktrees.map((worktree) => ({
    value: worktree.id,
    label: summarizeCreateTarget(createRepository, worktree.id),
  }));

  return (
    <AutomationPageShell layout={layout}>
      <div className={cn("flex flex-col gap-5", !compactLayout && "gap-6")}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-1">
              <h1 className={cn(
                "font-semibold tracking-tight text-foreground",
                compactLayout ? "text-2xl" : "text-3xl sm:text-4xl",
              )}
              >
                Automations
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Repository-aware jobs for recurring agent work.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                className={cn(compactLayout && "h-9 px-4")}
                onClick={() => handleCreateDialogOpenChange(true)}
                disabled={repositories.length === 0}
              >
                <Plus className="mr-2 h-4 w-4" />
                New automation
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-b border-border/40 pb-3">
            <ComposerFooterField label="Project" className="min-w-[220px]">
              <CompactSelectControl value={repositoryFilter} onChange={(event) => setRepositoryFilter(event.target.value)}>
                <option value="">All projects</option>
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.name}
                  </option>
                ))}
              </CompactSelectControl>
            </ComposerFooterField>
            <ComposerFooterField label="Status" className="min-w-[180px]">
              <CompactSelectControl value={enabledFilter} onChange={(event) => setEnabledFilter(event.target.value as AutomationEnabledFilter)}>
                {AUTOMATION_STATUS_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </CompactSelectControl>
            </ComposerFooterField>
          </div>
        </div>

        <section>
          {automationsQuery.isLoading ? (
            <div className="border-b border-border/40 py-8 text-sm text-muted-foreground">
              Loading automations...
            </div>
          ) : automations.length === 0 ? (
            <div className="border-b border-dashed border-border/50 py-10">
              <div className="space-y-2">
                <div className="text-lg font-medium text-foreground">No automations yet</div>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  Start with a daily standup summary, a release prep checklist, or an hourly watchdog. Each run opens its own thread so outputs stay inspectable.
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border/40 border-b border-border/40">
              {automations.map((automation) => (
                <AutomationListItem
                  key={automation.id}
                  automation={automation}
                  repositories={repositories}
                  compactLayout={compactLayout}
                  onOpen={openAutomationDetail}
                  onRun={(automationId) => runMutation.mutate(automationId)}
                  onToggle={(automationId, enabled) => toggleMutation.mutate({ automationId, enabled })}
                  onDelete={(automationId) => deleteMutation.mutate(automationId)}
                  runPending={runMutation.isPending}
                  togglePending={toggleMutation.isPending}
                  deletePending={deleteMutation.isPending}
                />
              ))}
            </div>
          )}
        </section>

      <Dialog open={createDialogOpen} onOpenChange={handleCreateDialogOpenChange}>
        <DialogContent className={cn(
          "max-h-[92vh] gap-0 overflow-y-auto rounded-2xl border-border/60 bg-background p-0 text-foreground shadow-2xl",
          compactLayout
            ? "max-w-[min(920px,calc(100vw-32px))]"
            : "max-w-[min(1100px,calc(100vw-32px))]",
        )}
        >
          <DialogHeader className="border-b border-border/50 px-6 py-5 sm:px-8">
            <DialogTitle>Create automation</DialogTitle>
            <DialogDescription className="sr-only">
              Create a scheduled automation with a target, model, and prompt.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 px-6 py-5 sm:px-8 sm:py-6">
            <div className="flex flex-col gap-3 border-b border-border/40 pb-4">
              <BareInputField
                value={createForm.name}
                onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Automation title"
              />
            </div>

            <div className="space-y-4">
              <AutomationPromptEditor
                value={createForm.prompt}
                onChange={(prompt) => setCreateForm((current) => ({ ...current, prompt }))}
                worktreeId={createForm.targetWorktreeId || null}
                agent={createForm.agent}
                placeholder="Add prompt e.g. look for crashes in $sentry. Type / or $ for skills and @ to mention files."
                className={cn(
                  "rounded-xl border-border/50 bg-secondary/[0.03] shadow-none",
                  compactLayout ? "min-h-[200px]" : "min-h-[240px]",
                )}
                testId="automation-create-prompt-editor"
              />
              {createError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
                  {createError}
                </div>
              ) : null}
            </div>

            <div className="border-t border-border/40 pt-4">
              <div
                className="grid gap-2 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.9fr)_minmax(0,1.15fr)_minmax(0,0.95fr)_auto] md:items-center"
                data-testid="automation-create-target-row"
              >
                <AutomationInlinePicker
                  icon={FolderOpen}
                  ariaLabel="Select project"
                  value={createForm.repositoryId}
                  selectedLabel={createRepository?.name ?? "Select project"}
                  options={createProjectOptions}
                  className="min-w-0 justify-between"
                  onSelect={(nextRepositoryId) => {
                    const nextWorktrees = getAvailableWorktrees(repositories, nextRepositoryId);
                    setCreateForm((current) => ({
                      ...current,
                      repositoryId: nextRepositoryId,
                      targetWorktreeId: nextWorktrees[0]?.id ?? "",
                    }));
                  }}
                  testId="automation-create-project-trigger"
                />

                <AutomationInlinePicker
                  icon={GitBranch}
                  ariaLabel="Select local or worktree"
                  value={createForm.targetWorktreeId}
                  selectedLabel={summarizeCreateTarget(createRepository, createForm.targetWorktreeId)}
                  options={createTargetOptions}
                  className="min-w-0 justify-between"
                  onSelect={(nextWorktreeId) => {
                    setCreateForm((current) => ({ ...current, targetWorktreeId: nextWorktreeId }));
                  }}
                  testId="automation-create-target-trigger"
                />

                <AutomationSessionPicker
                  value={{
                    agent: createForm.agent,
                    model: createForm.model,
                    modelProviderId: createForm.modelProviderId,
                    permissionMode: createForm.permissionMode,
                  }}
                  providers={providers}
                  codexModels={codexModels}
                  cursorModels={cursorModels}
                  opencodeModels={opencodeModels}
                  codexBuiltinModelOverride={codexBuiltinModelOverride}
                  className="min-w-0"
                  onSelectionChange={(selection) => {
                    setCreateForm((current) => ({
                      ...current,
                      agent: selection.agent,
                      model: selection.model,
                      modelProviderId: selection.modelProviderId,
                      chatMode: "default",
                    }));
                  }}
                  onPermissionModeChange={(permissionMode) => {
                    setCreateForm((current) => ({ ...current, permissionMode }));
                  }}
                  testId="automation-create-session-trigger"
                />

                <Popover>
                  <PopoverTrigger asChild>
                    <WorkspaceHeaderStylePickerTrigger
                      icon={CalendarClock}
                      aria-label="Select schedule"
                      className="min-w-0 w-full justify-between"
                      data-testid="automation-create-schedule-trigger"
                    >
                      {summarizeScheduleDraft(createForm)}
                    </WorkspaceHeaderStylePickerTrigger>
                  </PopoverTrigger>
                  <PopoverContent className="w-[360px] rounded-xl border-border/60 bg-popover p-4">
                    <AutomationScheduleEditor
                      form={createForm}
                      onChange={(next) => setCreateForm((current) => ({ ...current, ...next }))}
                    />
                  </PopoverContent>
                </Popover>

                <Button
                  type="button"
                  className="px-6 md:min-w-[108px]"
                  disabled={createMutation.isPending || repositories.length === 0}
                  onClick={() => createMutation.mutate(formToPayload(createForm))}
                >
                  {createMutation.isPending ? "Creating..." : "Create"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      </div>
    </AutomationPageShell>
  );
}

export function AutomationDetailPage({
  automationId,
  layout = "page",
  onBack,
}: AutomationDetailPageProps) {
  useWorkspaceSyncStream();

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const repositoriesQuery = useRepositories();
  const { providers } = useModelProviders();
  const repositories = repositoriesQuery.data;
  const detailQueryKey = queryKeys.automations.detail(automationId);
  const compactLayout = layout === "panel";
  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }

    startTransition(() => {
      void navigate({ to: "/automations" });
    });
  }, [navigate, onBack]);

  const automationQuery = useQuery({
    queryKey: detailQueryKey,
    queryFn: () => api.getAutomation(automationId),
    refetchInterval: 5_000,
  });
  const runsQuery = useQuery({
    queryKey: queryKeys.automations.runs(automationId),
    queryFn: () => api.listAutomationRuns(automationId),
    refetchInterval: 5_000,
  });
  const versionsQuery = useQuery({
    queryKey: queryKeys.automations.versions(automationId),
    queryFn: () => api.listAutomationPromptVersions(automationId),
    refetchInterval: 15_000,
  });

  const [saveError, setSaveError] = useState<string | null>(null);
  const [form, setForm] = useState<AutomationFormState | null>(null);

  useEffect(() => {
    if (!automationQuery.data) {
      return;
    }
    const nextForm = toFormState(repositories, providers, automationQuery.data);
    setForm((current) => {
      if (current === null) {
        return nextForm;
      }

      const currentPayload = JSON.stringify(formToUpdatePayload(current));
      const nextPayload = JSON.stringify(formToUpdatePayload(nextForm));
      return currentPayload === nextPayload ? nextForm : current;
    });
  }, [automationQuery.data, repositories, providers]);

  const saveMutation = useMutation({
    mutationFn: (payload: ReturnType<typeof formToUpdatePayload>) => api.updateAutomation(automationId, payload),
    onSuccess: () => {
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.versions(automationId) });
    },
    onError: (error) => {
      setSaveError(error instanceof Error ? error.message : "Unable to save automation");
    },
  });

  const runMutation = useMutation({
    mutationFn: () => api.runAutomationNow(automationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(automationId) });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateAutomation(automationId, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAutomation(automationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      handleBack();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (versionId: string) => api.restoreAutomationPromptVersion(automationId, versionId),
    onSuccess: (restoredAutomation) => {
      queryClient.setQueryData(detailQueryKey, restoredAutomation);
      setForm((current) => current
        ? { ...current, prompt: restoredAutomation.prompt }
        : toFormState(repositories, providers, restoredAutomation));

      void queryClient.invalidateQueries({ queryKey: detailQueryKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.versions(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
    },
  });

  const automation = automationQuery.data;

  if (automationQuery.isLoading || form === null || automation == null) {
    return (
      <AutomationPageShell layout={layout}>
        <div className="w-full border-y border-border/40 py-8 text-sm text-muted-foreground">
          Loading automation...
        </div>
      </AutomationPageShell>
    );
  }

  const repository = findRepositoryById(repositories, automation.repositoryId);
  const worktree = repository?.worktrees.find((entry) => entry.id === automation.targetWorktreeId) ?? null;
  const availableWorktrees = getAvailableWorktrees(repositories, automation.repositoryId);
  const providerOptions = getProvidersForAgent(providers, form.agent);
  const builtinModels = BUILTIN_CHAT_MODELS_BY_AGENT[form.agent];

  return (
    <AutomationPageShell layout={layout}>
      <div className={cn("flex flex-col gap-4", !compactLayout && "gap-6")}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          {onBack ? (
            <button
              type="button"
              className="inline-flex items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
              onClick={handleBack}
            >
              <span>Automations</span>
              <ChevronRight className="h-4 w-4" />
              <span className="truncate text-foreground">{automation.name}</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Link to="/automations" className="transition-colors hover:text-foreground">
                Automations
              </Link>
              <ChevronRight className="h-4 w-4" />
              <span className="truncate text-foreground">{automation.name}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className="h-9 px-3 text-muted-foreground hover:text-foreground"
              disabled={toggleMutation.isPending}
              onClick={() => toggleMutation.mutate(!automation.enabled)}
              aria-label={automation.enabled ? "Pause automation" : "Resume automation"}
            >
              {automation.enabled ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
              {automation.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-9 px-3 text-muted-foreground hover:text-foreground"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
              aria-label="Delete automation"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
            <Button
              type="button"
              className="px-5"
              disabled={runMutation.isPending}
              onClick={() => runMutation.mutate()}
            >
              <Play className="mr-2 h-4 w-4" />
              Run now
            </Button>
          </div>
        </div>

        <div className={cn(
          "grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]",
          !compactLayout && "gap-6 xl:grid-cols-[minmax(0,1fr)_360px]",
        )}
        >
          <section className="rounded-lg border border-border/40 bg-background/20 px-6 py-6 sm:px-8">
            <div className="mb-6 space-y-1">
              <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">Prompt</p>
              <p className="text-sm text-muted-foreground">Keep the instruction focused. Future runs reuse this draft until you save another change.</p>
            </div>

            <BareInputField
              value={form.name}
              onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
              placeholder="Automation title"
            />

            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>{repository?.name ?? automation.repositoryId}</span>
              <span>•</span>
              <span>{worktree?.branch ?? automation.targetWorktreeId}</span>
            </div>

            <div className="mt-8">
              <AutomationPromptEditor
                value={form.prompt}
                onChange={(prompt) => setForm((current) => current ? { ...current, prompt } : current)}
                worktreeId={form.targetWorktreeId || null}
                agent={form.agent}
                placeholder="Add prompt. Type / or $ for skills and @ to mention files."
                className={cn(compactLayout ? "min-h-[320px]" : "min-h-[420px]")}
                testId="automation-detail-prompt-editor"
              />
            </div>

            {saveError ? (
              <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
                {saveError}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">Edits apply to future runs.</div>
              <Button
                type="button"
                className="px-5"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate(formToUpdatePayload(form))}
              >
                <Save className="mr-2 h-4 w-4" />
                {saveMutation.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </section>

          <aside className="space-y-6 xl:border-l xl:border-border/40 xl:pl-6">
            <section className="space-y-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground">Configuration</h2>
              <div className="space-y-4">
                <SidebarRow label="Status">
                  <span className="inline-flex items-center gap-2 text-sm">
                    <span className={cn("h-2.5 w-2.5 rounded-full", automation.enabled ? "bg-emerald-400" : "bg-white/40")} />
                    {automation.enabled ? "Active" : "Paused"}
                  </span>
                </SidebarRow>
                <SidebarRow label="Next run">
                  <div className="space-y-1">
                    <div>{formatRelativeTime(automation.nextRunAt)}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(automation.nextRunAt)}</div>
                  </div>
                </SidebarRow>
                <SidebarRow label="Last ran">
                  <div className="space-y-1">
                    <div>{formatRelativeTime(automation.lastRunAt)}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(automation.lastRunAt)}</div>
                  </div>
                </SidebarRow>
                <SidebarRow label="Project">
                  <span>{repository?.name ?? automation.repositoryId}</span>
                </SidebarRow>
                <SidebarRow label="Worktree">
                  <CompactSelectControl
                    value={form.targetWorktreeId}
                    onChange={(event) => setForm((current) => current ? { ...current, targetWorktreeId: event.target.value } : current)}
                  >
                    {availableWorktrees.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.branch}
                      </option>
                    ))}
                  </CompactSelectControl>
                </SidebarRow>
                <SidebarRow label="Repeats">
                  <Popover>
                    <PopoverTrigger asChild>
                      <CompactPopoverButton>
                        <CompactPopoverLabel>{summarizeScheduleDraft(form)}</CompactPopoverLabel>
                      </CompactPopoverButton>
                    </PopoverTrigger>
                    <PopoverContent className="w-[360px] rounded-xl border-border/60 bg-popover p-4">
                      <AutomationScheduleEditor
                        form={form}
                        onChange={(next) => setForm((current) => current ? { ...current, ...next } : current)}
                      />
                    </PopoverContent>
                  </Popover>
                </SidebarRow>
                <SidebarRow label="Agent">
                  <CompactSelectControl
                    value={form.agent}
                    onChange={(event) => {
                      const nextAgent = event.target.value as CliAgent;
                      setForm((current) => current
                        ? {
                            ...current,
                            agent: nextAgent,
                            modelProviderId: null,
                            model: defaultModelForAgent(nextAgent),
                          }
                        : current);
                    }}
                  >
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                    <option value="cursor">Cursor</option>
                    <option value="opencode">Opencode</option>
                  </CompactSelectControl>
                </SidebarRow>
                <SidebarRow label="Provider">
                  <CompactSelectControl
                    value={form.modelProviderId ?? "__builtin__"}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      if (nextValue === "__builtin__") {
                        setForm((current) => current
                          ? { ...current, modelProviderId: null, model: defaultModelForAgent(current.agent) }
                          : current);
                        return;
                      }

                      const selectedProvider = providerOptions.find((provider) => provider.id === nextValue);
                      if (!selectedProvider) {
                        return;
                      }

                      setForm((current) => current
                        ? {
                            ...current,
                            modelProviderId: selectedProvider.id,
                            model: selectedProvider.modelId,
                          }
                        : current);
                    }}
                  >
                    <option value="__builtin__">Built-in model</option>
                    {providerOptions.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </CompactSelectControl>
                </SidebarRow>
                <SidebarRow label="Model">
                  <div className="border-b border-border/40 pb-1">
                    <CompactInputField
                      list="automation-detail-models"
                      value={form.model}
                      disabled={form.modelProviderId !== null}
                      onChange={(event) => setForm((current) => current ? { ...current, model: event.target.value } : current)}
                      className="w-full"
                    />
                    <datalist id="automation-detail-models">
                      {builtinModels.map((modelId) => (
                        <option key={modelId} value={modelId} />
                      ))}
                    </datalist>
                  </div>
                </SidebarRow>
                <SidebarRow label="Access">
                  <CompactSelectControl
                    value={form.permissionMode}
                    onChange={(event) => setForm((current) => current ? { ...current, permissionMode: event.target.value as ChatThreadPermissionMode } : current)}
                  >
                    <option value="default">Default approvals</option>
                    <option value="full_access">Full access</option>
                  </CompactSelectControl>
                </SidebarRow>
                <SidebarRow label="Mode">
                  <CompactSelectControl
                    value={form.chatMode}
                    onChange={(event) => setForm((current) => current ? { ...current, chatMode: event.target.value as ChatMode } : current)}
                  >
                    <option value="default">Execute</option>
                    <option value="plan">Plan</option>
                  </CompactSelectControl>
                </SidebarRow>
              </div>
            </section>

            <section className="space-y-4 border-t border-border/40 pt-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground">Runs</h2>
              <AutomationRunList automation={automation} runs={runsQuery.data ?? []} />
            </section>

            <section className="space-y-4 border-t border-border/40 pt-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground">Versions</h2>
              <VersionHistoryList
                versions={versionsQuery.data ?? []}
                restoringVersionId={restoreMutation.variables ?? null}
                onRestore={(versionId) => restoreMutation.mutate(versionId)}
              />
            </section>
          </aside>
        </div>
      </div>
    </AutomationPageShell>
  );
}

export function WorkspaceAutomationsPanel({
  automationId,
  create = false,
  prefills,
  onOpenAutomation,
  onBack,
  onCreateDialogOpenChange,
}: WorkspaceAutomationsPanelProps) {
  if (automationId) {
    return (
      <AutomationDetailPage
        automationId={automationId}
        layout="panel"
        onBack={onBack}
      />
    );
  }

  return (
    <AutomationsListPage
      key={create ? "create" : "browse"}
      prefills={{ ...prefills, create }}
      layout="panel"
      onOpenAutomation={onOpenAutomation}
      onCreateDialogOpenChange={onCreateDialogOpenChange}
    />
  );
}
