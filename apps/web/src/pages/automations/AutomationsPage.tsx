import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  Automation,
  AutomationTargetMode,
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
import { DEFAULT_CHAT_MODEL_BY_AGENT } from "@codesymphony/shared-types";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { queryKeys } from "../../lib/queryKeys";
import { useRepositories } from "../../hooks/queries/useRepositories";
import {
  AgentModelSelector,
  type AgentModelSelection,
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
  targetMode: AutomationTargetMode;
  name: string;
  prompt: string;
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
  chatMode: ChatMode;
  timezone: string;
  frequency: AutomationScheduleDraft["frequency"];
  hour: number;
  minute: number;
  daysOfWeek: string[];
};

type AutomationFormFieldError = "name" | "prompt" | "repositoryId" | "targetWorktreeId" | "session";
type AutomationFormValidationErrors = Partial<Record<AutomationFormFieldError, string>>;

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
  onOpenRun?: (run: AutomationRun, repositoryId: string) => void;
};

type WorkspaceAutomationsPanelProps = {
  automationId?: string | null;
  create?: boolean;
  prefills?: Omit<NonNullable<AutomationListPageProps["prefills"]>, "create">;
  onOpenAutomation: (automationId: string) => void;
  onBack: () => void;
  onOpenRun?: (run: AutomationRun, repositoryId: string) => void;
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

type AutomationSchedulePreset = "hourly" | "daily" | "weekdays" | "weekly";

const AUTOMATION_TARGET_OPTIONS: Array<{
  value: AutomationTargetMode;
  label: string;
}> = [
  { value: "repo_root", label: "Root" },
  { value: "worktree", label: "Worktree" },
];

const AUTOMATION_WORKWEEK_DAYS = ["MO", "TU", "WE", "TH", "FR"] as const;
const ACTIVE_AUTOMATION_RUN_STATUSES = new Set<AutomationRun["status"]>([
  "queued",
  "dispatching",
  "running",
  "waiting_input",
]);

const AUTOMATION_REPEAT_OPTIONS: Array<{
  value: AutomationSchedulePreset;
  label: string;
}> = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
];

const AUTOMATION_WEEKDAY_LABELS: Record<(typeof AUTOMATION_WEEKDAYS)[number], string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

const AUTOMATION_WEEKDAY_SHORT_LABELS: Record<(typeof AUTOMATION_WEEKDAYS)[number], string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

type AutomationWeekday = (typeof AUTOMATION_WEEKDAYS)[number];

const AUTOMATION_HOUR_OPTIONS = Array.from({ length: 24 }, (_unused, hour) => ({
  value: String(hour),
  label: new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 0, 1, hour, 0))),
}));

const AUTOMATION_MINUTE_OPTIONS = Array.from({ length: 60 }, (_unused, minute) => ({
  value: String(minute),
  label: String(minute).padStart(2, "0"),
}));

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

function getAutomationContextWorktreeId(repository: Repository | undefined) {
  return findRootWorktree(repository)?.id ?? "";
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

function getRunStatusVariant(status: string | null | undefined) {
  if (status === "failed" || status === "canceled") {
    return "destructive" as const;
  }
  if (status === "waiting_input") {
    return "secondary" as const;
  }
  if (status === "missed") {
    return "secondary" as const;
  }
  if (status === "running" || status === "dispatching" || status === "queued") {
    return "default" as const;
  }
  return "outline" as const;
}

function formatAutomationRunStatus(status: AutomationRun["status"]) {
  return status
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatAutomationTriggerKind(triggerKind: AutomationRun["triggerKind"]) {
  return triggerKind
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function isAutomationRunActive(run: Pick<AutomationRun, "status"> | null | undefined) {
  return Boolean(run && ACTIVE_AUTOMATION_RUN_STATUSES.has(run.status));
}

function getAutomationFormValidationErrors(
  form: AutomationFormState,
  repositories: Repository[],
): AutomationFormValidationErrors {
  const errors: AutomationFormValidationErrors = {};

  if (form.name.trim().length === 0) {
    errors.name = "Add a title before creating the automation.";
  }

  if (form.prompt.trim().length === 0) {
    errors.prompt = "Add a prompt so the automation knows what to do.";
  }

  const repository = findRepositoryById(repositories, form.repositoryId);
  if (!repository) {
    errors.repositoryId = "Select a project for this automation.";
  }

  if (form.targetWorktreeId.trim().length === 0) {
    errors.targetWorktreeId = form.targetMode === "worktree"
      ? "Select a source worktree before creating the automation."
      : "The selected project does not have an active root worktree.";
  }

  if (form.model.trim().length === 0) {
    errors.session = "Select an automation session before creating the automation.";
  }

  return errors;
}

function withUpdatedLatestRun(automation: Automation, run: AutomationRun): Automation {
  return {
    ...automation,
    latestRun: run,
    lastRunAt: run.scheduledFor,
  };
}

function applyAutomationLatestRunToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  automationId: string,
  run: AutomationRun,
) {
  queryClient.setQueriesData<Automation[]>({ queryKey: queryKeys.automations.lists }, (current) => (
    current?.map((automation) => (
      automation.id === automationId ? withUpdatedLatestRun(automation, run) : automation
    )) ?? current
  ));

  queryClient.setQueryData<Automation | undefined>(queryKeys.automations.detail(automationId), (current) => (
    current ? withUpdatedLatestRun(current, run) : current
  ));
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
    targetWorktreeId: getAutomationContextWorktreeId(repository) || automation?.targetWorktreeId || prefills?.worktreeId || "",
    targetMode: automation?.targetMode ?? "repo_root",
    name: automation?.name ?? "",
    prompt: automation?.prompt ?? "",
    agent: automation?.agent ?? prefills?.agent ?? "claude",
    model: automation?.model ?? prefills?.model ?? defaultModelForAgent(prefills?.agent ?? "claude"),
    modelProviderId: activeProvider?.id ?? null,
    chatMode: "default",
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
    targetMode: normalized.targetMode,
    name: normalized.name,
    prompt: normalized.prompt,
    agent: normalized.agent,
    model: normalized.model,
    modelProviderId: normalized.modelProviderId,
    permissionMode: "full_access" as const,
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
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto bg-background text-foreground">
        <div className="mx-auto flex h-full min-h-full w-full max-w-6xl flex-1 flex-col gap-4 px-3 pb-0 pt-3 sm:px-4 lg:px-5">
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

function BareInputField(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Input
      {...props}
      className={cn(
        "h-auto border-0 bg-transparent px-0 py-0 text-lg font-semibold tracking-[-0.015em] shadow-none outline-none ring-0 placeholder:text-muted-foreground/55 focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-xl",
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

function normalizeScheduleDays(daysOfWeek: string[]): AutomationWeekday[] {
  return [...new Set(daysOfWeek)]
    .filter((day): day is AutomationWeekday => AUTOMATION_WEEKDAYS.includes(day as AutomationWeekday))
    .sort((left, right) => AUTOMATION_WEEKDAYS.indexOf(left) - AUTOMATION_WEEKDAYS.indexOf(right));
}

function isWeekdaysSchedule(daysOfWeek: string[]) {
  const normalized = normalizeScheduleDays(daysOfWeek);
  return normalized.length === AUTOMATION_WORKWEEK_DAYS.length
    && AUTOMATION_WORKWEEK_DAYS.every((day) => normalized.includes(day));
}

function getAutomationSchedulePreset(
  schedule: Pick<AutomationFormState, "frequency" | "daysOfWeek">,
): AutomationSchedulePreset {
  if (schedule.frequency === "hourly") {
    return "hourly";
  }

  if (schedule.frequency === "daily") {
    return "daily";
  }

  return isWeekdaysSchedule(schedule.daysOfWeek) ? "weekdays" : "weekly";
}

function formatScheduleDayList(daysOfWeek: string[]) {
  const normalized = normalizeScheduleDays(daysOfWeek);
  if (normalized.length === 1) {
    return `${AUTOMATION_WEEKDAY_LABELS[normalized[0]]}s`;
  }

  return normalized.map((day) => AUTOMATION_WEEKDAY_SHORT_LABELS[day]).join(", ");
}

function summarizeScheduleDraft(schedule: Pick<AutomationFormState, "frequency" | "hour" | "minute" | "daysOfWeek">) {
  if (schedule.frequency === "hourly") {
    return `Hourly at :${String(schedule.minute).padStart(2, "0")}`;
  }

  const timeLabel = formatClockTime(schedule.hour, schedule.minute);
  if (schedule.frequency === "weekly") {
    if (isWeekdaysSchedule(schedule.daysOfWeek)) {
      return `Weekdays at ${timeLabel}`;
    }

    const normalizedDays = normalizeScheduleDays(schedule.daysOfWeek);
    if (normalizedDays.length === 0) {
      return `Weekly at ${timeLabel}`;
    }

    return `${formatScheduleDayList(normalizedDays)} at ${timeLabel}`;
  }

  return `Daily at ${timeLabel}`;
}

function ScheduleTimePicker({
  hour,
  minute,
  minuteOnly = false,
  onChange,
}: {
  hour: number;
  minute: number;
  minuteOnly?: boolean;
  onChange: (next: { hour?: number; minute?: number }) => void;
}) {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border/50 bg-secondary/30 px-3 py-2.5 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30">
      <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
      {minuteOnly ? (
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,4.25rem)_1fr] items-center gap-3">
          <select
            value={String(minute)}
            onChange={(event) => onChange({ minute: Number.parseInt(event.target.value, 10) })}
            className="min-w-0 bg-transparent px-0 py-0 text-sm text-foreground outline-none"
          >
            {AUTOMATION_MINUTE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            past each hour
          </span>
        </div>
      ) : (
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <select
            value={String(hour)}
            onChange={(event) => onChange({ hour: Number.parseInt(event.target.value, 10) })}
            className="min-w-0 bg-transparent px-0 py-0 text-sm text-foreground outline-none"
          >
            {AUTOMATION_HOUR_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-sm text-muted-foreground">:</span>
          <select
            value={String(minute)}
            onChange={(event) => onChange({ minute: Number.parseInt(event.target.value, 10) })}
            className="min-w-0 bg-transparent px-0 py-0 text-sm text-foreground outline-none"
          >
            {AUTOMATION_MINUTE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function getAutomationTargetIcon(targetMode: AutomationTargetMode) {
  return targetMode === "worktree" ? GitBranch : FolderGit2;
}

function summarizeCreateTarget(targetMode: AutomationTargetMode) {
  return targetMode === "worktree" ? "Worktree" : "Root";
}

type AutomationPickerOption = {
  value: string;
  label: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
};

function describeAutomationTarget(repository: Repository | undefined, targetMode: AutomationTargetMode) {
  if (!repository) {
    return undefined;
  }

  if (targetMode === "repo_root") {
    return "Runs in Root. If Root switches branch, future runs follow that branch.";
  }

  return `Creates a fresh worktree from ${repository.defaultBranch} for every run.`;
}

function WorkspaceHeaderStylePickerTrigger({
  icon: Icon,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-8 min-w-0 shrink-0 justify-between gap-1 rounded-md px-2 text-[12px] font-medium text-foreground/80 hover:bg-secondary/35 hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex items-center gap-1.5">
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" /> : null}
        <span className="truncate">{children}</span>
      </span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
    </Button>
  );
}

function AutomationInlinePicker({
  icon,
  selectedIcon,
  ariaLabel,
  value,
  selectedLabel,
  options,
  onSelect,
  className,
  testId,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  selectedIcon?: React.ComponentType<{ className?: string }>;
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
          icon={selectedIcon ?? icon}
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
                    "flex w-full items-start justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
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
                  <span className="min-w-0 flex items-start gap-2">
                    {option.icon ? <option.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">{option.label}</span>
                      {option.description ? (
                        <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {selected ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" /> : null}
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
  className,
  popoverContainer,
  testId,
}: {
  value: Pick<AutomationFormState, "agent" | "model" | "modelProviderId">;
  providers: ModelProvider[];
  codexModels: readonly CodexModelCatalogEntry[];
  cursorModels: readonly CursorModelCatalogEntry[];
  opencodeModels: readonly OpencodeModelCatalogEntry[];
  codexBuiltinModelOverride?: string | null;
  onSelectionChange: (selection: AgentModelSelection) => void;
  className?: string;
  popoverContainer?: HTMLElement | null;
  testId?: string;
}) {
  return (
    <AgentModelSelector
      selection={{
        agent: value.agent,
        model: value.model,
        modelProviderId: value.modelProviderId,
      }}
      providers={providers}
      codexModels={codexModels}
      cursorModels={cursorModels}
      opencodeModels={opencodeModels}
      codexBuiltinModelOverride={codexBuiltinModelOverride}
      showAgentList
      ariaLabel="Select automation session"
      className={className}
      popoverContainer={popoverContainer}
      triggerVariant="picker"
      triggerClassName="h-8 w-full px-2 hover:bg-secondary/35"
      onSelectionChange={onSelectionChange}
    />
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
  align = "start",
}: {
  label: string;
  children: React.ReactNode;
  align?: "start" | "center";
}) {
  return (
    <div className={cn(
      "grid gap-2 sm:grid-cols-[100px_minmax(0,1fr)]",
      align === "center" ? "sm:items-center" : "sm:items-start",
    )}
    >
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
  const preset = getAutomationSchedulePreset(form);
  const normalizedDays = normalizeScheduleDays(form.daysOfWeek);

  return (
    <div className="grid gap-3">
      <FieldShell label="Pattern">
        <SelectField
          value={preset}
          onChange={(event) => {
            const nextPreset = event.target.value as AutomationSchedulePreset;
            if (nextPreset === "hourly") {
              onChange({ frequency: "hourly", daysOfWeek: [] });
              return;
            }
            if (nextPreset === "daily") {
              onChange({ frequency: "daily", daysOfWeek: [] });
              return;
            }
            if (nextPreset === "weekdays") {
              onChange({ frequency: "weekly", daysOfWeek: [...AUTOMATION_WORKWEEK_DAYS] });
              return;
            }
            onChange({
              frequency: "weekly",
              daysOfWeek: normalizedDays.length > 0 && !isWeekdaysSchedule(normalizedDays) ? normalizedDays : ["MO"],
            });
          }}
          className="h-10 rounded-xl px-4 text-sm shadow-none"
        >
          {AUTOMATION_REPEAT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </FieldShell>

      {preset === "hourly" ? (
        <FieldShell label="Minute">
          <ScheduleTimePicker
            hour={form.hour}
            minute={form.minute}
            minuteOnly
            onChange={(next) => onChange(next)}
          />
        </FieldShell>
      ) : (
        <div className="min-w-0">
          <ScheduleTimePicker
            hour={form.hour}
            minute={form.minute}
            onChange={(next) => onChange(next)}
          />
        </div>
      )}

      {preset === "weekly" ? (
        <FieldShell label="Days">
          <div className="flex flex-wrap gap-1.5">
            {AUTOMATION_WEEKDAYS.map((day) => {
              const selected = normalizedDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    selected
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border/60 bg-background text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                  onClick={() => onChange({ daysOfWeek: toggleScheduleDay(normalizedDays, day) })}
                >
                  {AUTOMATION_WEEKDAY_SHORT_LABELS[day]}
                </button>
              );
            })}
          </div>
        </FieldShell>
      ) : null}
    </div>
  );
}

function AutomationRunList({
  automation,
  runs,
  onOpenRun,
}: {
  automation: Automation;
  runs: AutomationRun[];
  onOpenRun?: (run: AutomationRun, repositoryId: string) => void;
}) {
  return (
    <div className="space-y-3">
      {runs.length === 0 ? (
        <div className="pt-1 text-sm text-muted-foreground">
          No runs yet. Trigger a manual run to create the first thread.
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {runs.map((run) => (
            <div key={run.id} className="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant={getRunStatusVariant(run.status)}>
                    {formatAutomationRunStatus(run.status)}
                  </Badge>
                  <Badge variant="outline">
                    {formatAutomationTriggerKind(run.triggerKind)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{formatRelativeTime(run.scheduledFor)}</span>
                </div>
                <p className="line-clamp-2 text-sm text-foreground">{run.summary ?? run.error ?? "Run linked to a workspace thread."}</p>
                <div className="text-xs text-muted-foreground">{formatDateTime(run.scheduledFor)}</div>
              </div>

              {run.threadId ? (
                onOpenRun ? (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:text-primary/80"
                    onClick={() => onOpenRun(run, automation.repositoryId)}
                  >
                    Open
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <Link
                    to="/"
                    search={buildWorkspaceSearch(run, automation.repositoryId)}
                    className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:text-primary/80"
                  >
                    Open
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                )
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
        <div className="pt-1 text-sm text-muted-foreground">
          Prompt versions will appear here after edits.
        </div>
      ) : (
        <div className="divide-y divide-border/40">
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
  const activeRun = isAutomationRunActive(automation.latestRun) ? automation.latestRun : null;
  const runActionDisabled = runPending || activeRun !== null;

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
            "flex items-center justify-end gap-2 whitespace-nowrap text-right text-sm text-muted-foreground transition-opacity",
            moreOpen && "opacity-0",
            !moreOpen && "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          {activeRun ? (
            <>
              <Badge variant={getRunStatusVariant(activeRun.status)}>
                {formatAutomationRunStatus(activeRun.status)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(activeRun.startedAt ?? activeRun.scheduledFor)}
              </span>
            </>
          ) : (
            scheduleSummary
          )}
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
            disabled={runActionDisabled}
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
  const [createValidationErrors, setCreateValidationErrors] = useState<AutomationFormValidationErrors>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<AutomationFormState>(() => toFormState(repositories, providers, null, prefills));
  const [createDialogPopoverHost, setCreateDialogPopoverHost] = useState<HTMLDivElement | null>(null);
  const compactLayout = layout === "panel";

  const handleCreateDialogOpenChange = useCallback((open: boolean) => {
    setCreateDialogOpen(open);
    if (!open) {
      setCreateError(null);
      setCreateValidationErrors({});
    }
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
  const automations = automationsQuery.data ?? [];
  const automationById = useMemo(
    () => new Map(automations.map((automation) => [automation.id, automation])),
    [automations],
  );

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
      setCreateValidationErrors({});
      setCreateForm(toFormState(repositories, providers, null, prefills));
      openAutomationDetail(automation.id);
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error.message : "Unable to create automation");
    },
  });

  const runMutation = useMutation({
    mutationFn: api.runAutomationNow,
    onMutate: (automationId) => {
      setActionError(null);
      const automation = automationById.get(automationId);
      if (!automation) {
        return;
      }

      const now = new Date().toISOString();
      applyAutomationLatestRunToCache(queryClient, automationId, {
        id: `optimistic-${automationId}`,
        automationId,
        repositoryId: automation.repositoryId,
        worktreeId: automation.targetWorktreeId,
        threadId: automation.latestRun?.threadId ?? null,
        status: "dispatching",
        triggerKind: "manual",
        scheduledFor: now,
        startedAt: now,
        finishedAt: null,
        error: null,
        summary: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    onSuccess: (_run, automationId) => {
      applyAutomationLatestRunToCache(queryClient, automationId, _run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(automationId) });
    },
    onError: (error, automationId) => {
      setActionError(error instanceof Error ? error.message : "Unable to run automation");
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ automationId, enabled }: { automationId: string; enabled: boolean }) =>
      api.updateAutomation(automationId, { enabled }),
    onSuccess: (_automation, variables) => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(variables.automationId) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteAutomation,
    onSuccess: (_result, automationId) => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });
      void queryClient.removeQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.removeQueries({ queryKey: queryKeys.automations.runs(automationId) });
      void queryClient.removeQueries({ queryKey: queryKeys.automations.versions(automationId) });
    },
  });
  const createRepository = findRepositoryById(repositories, createForm.repositoryId);
  const codexModels = codexModelsQuery.data?.models ?? [];
  const cursorModels = cursorModelsQuery.data?.models ?? [];
  const opencodeModels = opencodeModelsQuery.data?.models ?? [];
  const codexBuiltinModelOverride = runtimeInfo.data?.codexCliProviderOverride?.model ?? null;
  const createProjectOptions = repositories.map((repository) => ({
    value: repository.id,
    label: repository.name,
  }));
  const createTargetOptions = AUTOMATION_TARGET_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: describeAutomationTarget(createRepository, option.value),
    icon: getAutomationTargetIcon(option.value),
  }));
  const updateCreateForm = useCallback((
    next: Partial<AutomationFormState>,
    clearedErrors: AutomationFormFieldError[] = [],
  ) => {
    setCreateForm((current) => ({ ...current, ...next }));
    if (createError) {
      setCreateError(null);
    }
    if (clearedErrors.length > 0) {
      setCreateValidationErrors((current) => {
        if (Object.keys(current).length === 0) {
          return current;
        }

        const nextErrors = { ...current };
        for (const key of clearedErrors) {
          delete nextErrors[key];
        }
        return nextErrors;
      });
    }
  }, [createError]);
  const handleCreateSubmit = useCallback(() => {
    const validationErrors = getAutomationFormValidationErrors(createForm, repositories);
    if (Object.keys(validationErrors).length > 0) {
      setCreateValidationErrors(validationErrors);
      setCreateError(null);
      return;
    }

    createMutation.mutate(formToPayload(createForm));
  }, [createForm, createMutation, repositories]);

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
          {actionError ? (
            <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
              {actionError}
            </div>
          ) : null}
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
                  runPending={runMutation.isPending && runMutation.variables === automation.id}
                  togglePending={toggleMutation.isPending && toggleMutation.variables?.automationId === automation.id}
                  deletePending={deleteMutation.isPending && deleteMutation.variables === automation.id}
                />
              ))}
            </div>
          )}
        </section>

      {createDialogOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create automation"
          className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-4 backdrop-blur-sm"
        >
          <div
            className={cn(
              "relative my-auto w-full overflow-visible rounded-xl border border-border/50 bg-background p-0 text-foreground shadow-xl",
              compactLayout
                ? "max-w-[min(920px,calc(100vw-32px))]"
                : "max-w-[min(1100px,calc(100vw-32px))]",
            )}
          >
            <div
              ref={setCreateDialogPopoverHost}
              className="pointer-events-none absolute inset-0 z-[60] overflow-visible"
            />
            <button
              type="button"
              className="absolute right-4 top-4 z-10 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              onClick={() => handleCreateDialogOpenChange(false)}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="max-h-[92vh] overflow-y-auto">
              <div className="px-6 pb-0 pt-5 sm:px-8 sm:pt-5">
                <h2 className="sr-only">Create automation</h2>
                <p className="sr-only">Create a scheduled automation with a target, model, and prompt.</p>
                <BareInputField
                  value={createForm.name}
                  onChange={(event) => updateCreateForm({ name: event.target.value }, ["name"])}
                  placeholder="Automation title"
                />
                {createValidationErrors.name ? (
                  <div className="mt-2 text-sm text-destructive">
                    {createValidationErrors.name}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-3 px-6 pb-5 pt-2 sm:px-8 sm:pb-6 sm:pt-2.5">
                <div className="border-b border-border/35 pb-3">
                  <AutomationPromptEditor
                    value={createForm.prompt}
                    onChange={(prompt) => updateCreateForm({ prompt }, ["prompt"])}
                    worktreeId={createForm.targetWorktreeId || null}
                    agent={createForm.agent}
                    placeholder="Add prompt e.g. look for crashes in $sentry. Type / or $ for skills and @ to mention files."
                    className={cn(
                      "rounded-none border-0 bg-transparent px-0 py-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0",
                      compactLayout ? "min-h-[220px]" : "min-h-[260px]",
                    )}
                    testId="automation-create-prompt-editor"
                  />
                  {createValidationErrors.prompt ? (
                    <div className="mt-3 text-sm text-destructive">
                      {createValidationErrors.prompt}
                    </div>
                  ) : null}
                  {createError ? (
                    <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                      {createError}
                    </div>
                  ) : null}
                </div>

                <div className="pt-1">
                  <div
                    className="grid gap-1.5 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.9fr)_minmax(0,1.15fr)_minmax(0,0.95fr)_auto] md:items-center"
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
                        const nextRepository = findRepositoryById(repositories, nextRepositoryId);
                        updateCreateForm({
                          repositoryId: nextRepositoryId,
                          targetWorktreeId: getAutomationContextWorktreeId(nextRepository),
                        }, ["repositoryId", "targetWorktreeId"]);
                      }}
                      testId="automation-create-project-trigger"
                    />

                    <AutomationInlinePicker
                      icon={getAutomationTargetIcon(createForm.targetMode)}
                      selectedIcon={getAutomationTargetIcon(createForm.targetMode)}
                      ariaLabel="Select root or worktree"
                      value={createForm.targetMode}
                      selectedLabel={summarizeCreateTarget(createForm.targetMode)}
                      options={createTargetOptions}
                      className="min-w-0 justify-between"
                      onSelect={(nextTargetMode) => {
                        updateCreateForm({
                          targetMode: nextTargetMode as AutomationTargetMode,
                        }, ["targetWorktreeId"]);
                      }}
                      testId="automation-create-target-trigger"
                    />

                    <AutomationSessionPicker
                      value={{
                        agent: createForm.agent,
                        model: createForm.model,
                        modelProviderId: createForm.modelProviderId,
                      }}
                      providers={providers}
                      codexModels={codexModels}
                      cursorModels={cursorModels}
                      opencodeModels={opencodeModels}
                      codexBuiltinModelOverride={codexBuiltinModelOverride}
                      className="min-w-0"
                      popoverContainer={createDialogPopoverHost}
                      onSelectionChange={(selection) => {
                        updateCreateForm({
                          agent: selection.agent,
                          model: selection.model,
                          modelProviderId: selection.modelProviderId,
                          chatMode: "default",
                        }, ["session"]);
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
                      <PopoverContent className="w-[min(256px,calc(100vw-32px))] rounded-xl border-border/60 bg-popover p-3.5">
                        <AutomationScheduleEditor
                          form={createForm}
                          onChange={(next) => updateCreateForm(next)}
                        />
                      </PopoverContent>
                    </Popover>

                    <Button
                      type="button"
                      className="h-8 px-5 md:min-w-[104px]"
                      disabled={createMutation.isPending || repositories.length === 0}
                      onClick={handleCreateSubmit}
                    >
                      {createMutation.isPending ? "Creating..." : "Create"}
                    </Button>
                  </div>
                  {createValidationErrors.repositoryId || createValidationErrors.targetWorktreeId || createValidationErrors.session ? (
                    <div className="pt-2 text-sm text-destructive">
                      {createValidationErrors.repositoryId ?? createValidationErrors.targetWorktreeId ?? createValidationErrors.session}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </AutomationPageShell>
  );
}

export function AutomationDetailPage({
  automationId,
  layout = "page",
  onBack,
  onOpenRun,
}: AutomationDetailPageProps) {
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
  const [actionError, setActionError] = useState<string | null>(null);
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
    onMutate: () => {
      setActionError(null);
      if (!automationQuery.data) {
        return;
      }

      const now = new Date().toISOString();
      applyAutomationLatestRunToCache(queryClient, automationId, {
        id: `optimistic-${automationId}`,
        automationId,
        repositoryId: automationQuery.data.repositoryId,
        worktreeId: automationQuery.data.targetWorktreeId,
        threadId: automationQuery.data.latestRun?.threadId ?? null,
        status: "dispatching",
        triggerKind: "manual",
        scheduledFor: now,
        startedAt: now,
        finishedAt: null,
        error: null,
        summary: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    onSuccess: (run) => {
      applyAutomationLatestRunToCache(queryClient, automationId, run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(automationId) });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Unable to run automation");
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
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
  const detailTargetOptions = AUTOMATION_TARGET_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: describeAutomationTarget(repository, option.value),
    icon: getAutomationTargetIcon(option.value),
  }));
  const codexModels = codexModelsQuery.data?.models ?? [];
  const cursorModels = cursorModelsQuery.data?.models ?? [];
  const opencodeModels = opencodeModelsQuery.data?.models ?? [];
  const codexBuiltinModelOverride = runtimeInfo.data?.codexCliProviderOverride?.model ?? null;
  const activeRun = (runsQuery.data ?? []).find((run) => isAutomationRunActive(run))
    ?? (isAutomationRunActive(automation.latestRun) ? automation.latestRun : null);

  return (
    <AutomationPageShell layout={layout}>
      <div className={cn("flex flex-col gap-4", compactLayout && "h-full min-h-full flex-1", !compactLayout && "gap-6")}>
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
              disabled={runMutation.isPending || activeRun !== null}
              onClick={() => runMutation.mutate()}
            >
              <Play className="mr-2 h-4 w-4" />
              {activeRun ? `${formatAutomationRunStatus(activeRun.status)}...` : "Run now"}
            </Button>
          </div>
        </div>

        {actionError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
            {actionError}
          </div>
        ) : null}

        <div className={cn(
          "grid min-h-0 flex-1 items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_320px]",
          !compactLayout && "gap-6 xl:grid-cols-[minmax(0,1fr)_360px]",
        )}
        >
          <section className="min-w-0 px-1 py-1 sm:px-2">
            <BareInputField
              value={form.name}
              onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
              placeholder="Automation title"
            />

            <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm text-muted-foreground">
              <span>{repository?.name ?? automation.repositoryId}</span>
              <span>•</span>
              <span>{summarizeCreateTarget(automation.targetMode)}</span>
            </div>

            <div className="mt-5 border-b border-border/35 pb-3">
              <AutomationPromptEditor
                value={form.prompt}
                onChange={(prompt) => setForm((current) => current ? { ...current, prompt } : current)}
                worktreeId={form.targetWorktreeId || null}
                agent={form.agent}
                placeholder="Add prompt. Type / or $ for skills and @ to mention files."
                className={cn(
                  "rounded-none border-0 bg-transparent px-0 py-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0",
                  compactLayout ? "min-h-[320px]" : "min-h-[420px]",
                )}
                testId="automation-detail-prompt-editor"
              />
            </div>

            {saveError ? (
              <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
                {saveError}
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">Edits apply to future runs.</div>
              <Button
                type="button"
                className="h-8 px-5"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate(formToUpdatePayload(form))}
              >
                <Save className="mr-2 h-4 w-4" />
                {saveMutation.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </section>

          <aside className="relative xl:self-stretch">
            <div className="absolute inset-y-0 left-0 hidden border-l border-border/35 xl:block" aria-hidden="true" />
            <section className="space-y-4 pb-5 xl:px-5">
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
                <SidebarRow label="Project" align="center">
                  <span>{repository?.name ?? automation.repositoryId}</span>
                </SidebarRow>
                <SidebarRow label="Target" align="center">
                  <AutomationInlinePicker
                    icon={getAutomationTargetIcon(form.targetMode)}
                    selectedIcon={getAutomationTargetIcon(form.targetMode)}
                    ariaLabel="Select root or worktree"
                    value={form.targetMode}
                    selectedLabel={summarizeCreateTarget(form.targetMode)}
                    options={detailTargetOptions}
                    className="justify-between"
                    onSelect={(nextTargetMode) => {
                      setForm((current) => current ? {
                        ...current,
                        targetMode: nextTargetMode as AutomationTargetMode,
                        targetWorktreeId: getAutomationContextWorktreeId(repository),
                      } : current);
                    }}
                    testId="automation-detail-target-trigger"
                  />
                </SidebarRow>
                <SidebarRow label="Repeats" align="center">
                  <Popover>
                    <PopoverTrigger asChild>
                      <WorkspaceHeaderStylePickerTrigger
                        icon={CalendarClock}
                        aria-label="Select schedule"
                        className="w-full justify-between"
                        data-testid="automation-detail-schedule-trigger"
                      >
                        {summarizeScheduleDraft(form)}
                      </WorkspaceHeaderStylePickerTrigger>
                    </PopoverTrigger>
                    <PopoverContent className="w-[min(256px,calc(100vw-32px))] rounded-xl border-border/60 bg-popover p-3.5">
                      <AutomationScheduleEditor
                        form={form}
                        onChange={(next) => setForm((current) => current ? { ...current, ...next } : current)}
                      />
                    </PopoverContent>
                  </Popover>
                </SidebarRow>
                <SidebarRow label="Session" align="center">
                  <AutomationSessionPicker
                    value={{
                      agent: form.agent,
                      model: form.model,
                      modelProviderId: form.modelProviderId,
                    }}
                    providers={providers}
                    codexModels={codexModels}
                    cursorModels={cursorModels}
                    opencodeModels={opencodeModels}
                    codexBuiltinModelOverride={codexBuiltinModelOverride}
                    className="min-w-0"
                    onSelectionChange={(selection) => {
                      setForm((current) => current
                        ? {
                            ...current,
                            agent: selection.agent,
                            model: selection.model,
                            modelProviderId: selection.modelProviderId,
                            chatMode: "default",
                          }
                        : current);
                    }}
                    testId="automation-detail-session-trigger"
                  />
                </SidebarRow>
              </div>
            </section>

            <section className="space-y-4 border-t border-border/40 py-5 xl:px-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-foreground">Runs</h2>
              <AutomationRunList
                automation={automation}
                runs={runsQuery.data ?? []}
                onOpenRun={onOpenRun}
              />
            </section>

            <section className="space-y-4 pt-5 xl:px-5">
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
  onOpenRun,
  onCreateDialogOpenChange,
}: WorkspaceAutomationsPanelProps) {
  if (automationId) {
    return (
      <AutomationDetailPage
        automationId={automationId}
        layout="panel"
        onBack={onBack}
        onOpenRun={onOpenRun}
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
